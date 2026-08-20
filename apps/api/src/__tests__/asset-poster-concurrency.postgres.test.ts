import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssetKind, PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createProjectAssetMutationRepository } from '../modules/admin/project/asset-mutation.repository.js';
import { createProjectAssetService } from '../modules/admin/project/project-asset.service.js';
import { createAssetsRepository } from '../modules/assets/repository.js';
import { createAssetsService } from '../modules/assets/service.js';
import { ASSET_MUTATION_TRANSACTION_POLICY } from '../modules/assets/mutation-transaction.js';
import { createOrphanRepository } from '../modules/orphan/repository.js';
import { createOrphanService } from '../modules/orphan/service.js';
import { createObjectReferenceResolver } from '../modules/orphan/reference-resolver.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const BARRIER_NAMESPACE = 50_050;
const REPETITIONS = 3;

type BarrierResource = 'assets' | 'projects';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function databaseUrlWithApplicationName(databaseUrl: string, applicationName: string): string {
	const parsed = new URL(databaseUrl);
	parsed.searchParams.set('application_name', applicationName);
	return parsed.toString();
}

function emptyParts() {
	return (async function* parts() {})();
}

describe.runIf(runPostgresIntegration)('asset/poster concurrency with PostgreSQL barriers', () => {
	let control: PrismaClient;
	let barrierClient: PrismaClient;
	let operationA: PrismaClient;
	let operationB: PrismaClient;
	let userId: number;
	let exhibitionId: number;
	let fixtureSequence = 0;
	let barrierSequence = 10_000;
	const testId = randomUUID();
	const bucket = `ticket-005-${testId}`;
	const createdProjectIds: number[] = [];

	async function createProjectFixture() {
		fixtureSequence += 1;
		const project = await control.project.create({
			data: {
				exhibitionId,
				creatorId: userId,
				slug: `ticket-005-${testId}-${fixtureSequence}`,
				title: `Ticket 005 fixture ${fixtureSequence}`,
				status: 'PUBLISHED',
			},
		});
		createdProjectIds.push(project.id);
		return project;
	}

	async function createAssetFixture(
		projectId: number,
		kind: AssetKind,
		storageKey: string,
	) {
		return control.asset.create({
			data: {
				projectId,
				kind,
				storageKey,
				originalName: storageKey.split('/').at(-1) ?? 'asset.bin',
				mimeType: kind === 'GAME' ? 'application/zip' : 'image/png',
				sizeBytes: 8n,
				status: 'READY',
				isPublic: kind !== 'GAME',
			},
		});
	}

	async function waitForDatabaseLock(applicationName: string): Promise<void> {
		for (let attempt = 0; attempt < 300; attempt += 1) {
			const rows = await control.$queryRaw<Array<{ waiting: boolean }>>`
				SELECT EXISTS (
					SELECT 1
					FROM pg_stat_activity
					WHERE application_name = ${applicationName}
						AND state = 'active'
						AND wait_event_type = 'Lock'
				) AS "waiting"
			`;
			if (rows[0]?.waiting) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`Timed out waiting for PostgreSQL lock barrier: ${applicationName}`);
	}

	async function armBarrier(resource: BarrierResource, resourceId: number) {
		barrierSequence += 1;
		const barrierKey = barrierSequence;
		await control.$executeRaw`
			INSERT INTO "ticket_005_mutation_barriers" ("resource_type", "resource_id", "barrier_key")
			VALUES (${resource}, ${resourceId}, ${barrierKey})
			ON CONFLICT ("resource_type", "resource_id")
			DO UPDATE SET "barrier_key" = EXCLUDED."barrier_key"
		`;

		const acquired = deferred();
		const releaseGate = deferred();
		const holder = barrierClient.$transaction(async (tx) => {
			// `$executeRaw` intentionally discards PostgreSQL's unsupported `void`
			// return type while retaining this transaction-scoped advisory lock.
			await tx.$executeRaw`
				SELECT pg_advisory_xact_lock(${BARRIER_NAMESPACE}, ${barrierKey})
			`;
			acquired.resolve();
			await releaseGate.promise;
		}, { maxWait: 5_000, timeout: 20_000 });
		await acquired.promise;

		let released = false;
		return {
			async release() {
				if (released) return;
				released = true;
				releaseGate.resolve();
				await holder;
			},
		};
	}

	function createDeletionService(
		client: PrismaClient,
		objects: Set<string>,
		failStorage = false,
	) {
		const orphanService = createOrphanService({
			clock: { now: () => new Date() },
			storage: {
				delete: async (_bucket, key) => {
					if (failStorage) throw new Error('forced storage failure');
					objects.delete(key);
				},
				listKeyPage: async () => ({ keys: [], isTruncated: false }),
				deleteKeys: async (_bucket, keys) => ({ deleted: [...keys], failures: [] }),
			},
			repository: createOrphanRepository(client),
			references: createObjectReferenceResolver(
				client,
				{ publicBucket: bucket, protectedBucket: bucket },
				{ error: vi.fn() },
			),
			logger: { info: vi.fn(), error: vi.fn() },
		});
		let deletionWork = Promise.resolve();
		const wakeDeletionWorker = () => {
			deletionWork = deletionWork.then(async () => {
				let result;
				do {
					result = await orphanService.runOrphanReaper();
				} while (result.tried === 50);
			});
		};
		const service = createAssetsService({
			presign: vi.fn(),
			bucketForKind: () => bucket,
			wakeDeletionWorker,
			loadProjectWithAccess: async () => ({}),
			downloadLimiter: { check: () => ({ status: 'ok' }) },
			logger: { info: vi.fn(), error: vi.fn() },
			repository: createAssetsRepository(client),
		});
		return Object.assign(service, { drainDeletion: () => deletionWork });
	}

	function createGameUploadService(input: {
		client: PrismaClient;
		storageKey: string;
		objects: Set<string>;
		maxAttempts?: number;
	}) {
		const rollback = vi.fn(async () => { input.objects.delete(input.storageKey); });
		const cleanup = vi.fn(async () => {});
		const mutationRepository = createProjectAssetMutationRepository(input.client, {
			...ASSET_MUTATION_TRANSACTION_POLICY,
			maxAttempts: input.maxAttempts ?? ASSET_MUTATION_TRANSACTION_POLICY.maxAttempts,
		});
		const orphanService = createOrphanService({
			clock: { now: () => new Date() },
			storage: {
				delete: async (_bucket, key) => { input.objects.delete(key); },
				listKeyPage: async () => ({ keys: [], isTruncated: false }),
				deleteKeys: async (_bucket, keys) => ({ deleted: [...keys], failures: [] }),
			},
			repository: createOrphanRepository(input.client),
			references: createObjectReferenceResolver(
				input.client,
				{ publicBucket: bucket, protectedBucket: bucket },
				{ error: vi.fn() },
			),
			logger: { info: vi.fn(), error: vi.fn() },
		});
		let deletionWork = Promise.resolve();
		const wakeDeletionWorker = () => {
			deletionWork = deletionWork.then(async () => {
				let result;
				do {
					result = await orphanService.runOrphanReaper();
				} while (result.tried === 50);
			});
		};
		const service = createProjectAssetService({
			repository: {
				...mutationRepository,
				findExhibitionById: (id) => input.client.exhibition.findUnique({ where: { id } }),
				createAsset: (data) => input.client.asset.create({ data, select: { id: true } }),
			},
			uploadLimits: () => ({
				posterMaxBytes: 1024,
				imageMaxBytes: 1024,
				gameMaxBytes: 1024,
				videoMaxBytes: 1024,
				requestMaxBytes: 2048,
				maxFiles: 1,
			}),
			uploadSlots: { acquire: vi.fn(), release: vi.fn() },
			uploadCoordinator: {
				start: async () => {
					input.objects.add(input.storageKey);
					return {
						savedFile: {
							storageKey: input.storageKey,
							mimeType: 'application/zip',
							sizeBytes: 8,
							originalName: 'replacement.zip',
							kind: 'GAME' as const,
						},
						rollback,
						cleanup,
					};
				},
			},
			bucketForKind: () => bucket,
			wakeDeletionWorker,
		});
		return { service, rollback, cleanup, drainDeletion: () => deletionWork };
	}

	async function expectProjectInvariants(projectId: number, objects: Set<string>) {
		const project = await control.project.findUniqueOrThrow({
			where: { id: projectId },
			include: { poster: true },
		});
		if (project.posterAssetId !== null) {
			expect(project.poster).toMatchObject({
				projectId,
				status: 'READY',
			});
			expect(['POSTER', 'IMAGE', 'THUMBNAIL']).toContain(project.poster?.kind);
		}
		const readyGames = await control.asset.findMany({
			where: { projectId, kind: 'GAME', status: 'READY' },
		});
		expect(readyGames.length).toBeLessThanOrEqual(1);
		const readyAssets = await control.asset.findMany({
			where: { projectId, status: 'READY' },
		});
		for (const asset of readyAssets) {
			expect(objects.has(asset.storageKey), `missing READY object ${asset.storageKey}`).toBe(true);
			if (asset.playbackStorageKey) {
				expect(objects.has(asset.playbackStorageKey)).toBe(true);
			}
		}
	}

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
		control = createPrismaClientForDatabase(databaseUrlWithApplicationName(databaseUrl, 'ticket005-control'));
		barrierClient = createPrismaClientForDatabase(databaseUrlWithApplicationName(databaseUrl, 'ticket005-holder'));
		operationA = createPrismaClientForDatabase(databaseUrlWithApplicationName(databaseUrl, 'ticket005-operation-a'));
		operationB = createPrismaClientForDatabase(databaseUrlWithApplicationName(databaseUrl, 'ticket005-operation-b'));
		await Promise.all([
			control.$connect(),
			barrierClient.$connect(),
			operationA.$connect(),
			operationB.$connect(),
		]);

		await control.$executeRawUnsafe(`
			CREATE TABLE IF NOT EXISTS "ticket_005_mutation_barriers" (
				"resource_type" text NOT NULL,
				"resource_id" integer NOT NULL,
				"barrier_key" integer NOT NULL,
				PRIMARY KEY ("resource_type", "resource_id")
			)
		`);
		await control.$executeRawUnsafe('TRUNCATE TABLE "ticket_005_mutation_barriers"');
		await control.$executeRawUnsafe(`
			CREATE OR REPLACE FUNCTION "ticket_005_wait_for_mutation_barrier"()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $function$
			DECLARE selected_key integer;
			BEGIN
				SELECT "barrier_key" INTO selected_key
				FROM "ticket_005_mutation_barriers"
				WHERE "resource_type" = TG_TABLE_NAME
					AND "resource_id" = NEW."id";
				IF selected_key IS NOT NULL THEN
					PERFORM pg_advisory_xact_lock(${BARRIER_NAMESPACE}, selected_key);
				END IF;
				RETURN NEW;
			END
			$function$
		`);
		await control.$executeRawUnsafe('DROP TRIGGER IF EXISTS "ticket_005_assets_barrier" ON "assets"');
		await control.$executeRawUnsafe(`
			CREATE TRIGGER "ticket_005_assets_barrier"
			BEFORE UPDATE ON "assets"
			FOR EACH ROW EXECUTE FUNCTION "ticket_005_wait_for_mutation_barrier"()
		`);
		await control.$executeRawUnsafe('DROP TRIGGER IF EXISTS "ticket_005_projects_barrier" ON "projects"');
		await control.$executeRawUnsafe(`
			CREATE TRIGGER "ticket_005_projects_barrier"
			BEFORE UPDATE ON "projects"
			FOR EACH ROW EXECUTE FUNCTION "ticket_005_wait_for_mutation_barrier"()
		`);

		const user = await control.user.create({
			data: {
				googleSub: `ticket-005-${testId}`,
				email: `ticket-005-${testId}@example.test`,
				name: 'Ticket 005 integration',
				role: 'ADMIN',
			},
		});
		userId = user.id;
		const exhibition = await control.exhibition.create({
			data: { year: 2205, title: `Ticket 005 ${testId}` },
		});
		exhibitionId = exhibition.id;
	});

	afterAll(async () => {
		if (!control) return;
		await control.$executeRawUnsafe('DROP TRIGGER IF EXISTS "ticket_005_assets_barrier" ON "assets"');
		await control.$executeRawUnsafe('DROP TRIGGER IF EXISTS "ticket_005_projects_barrier" ON "projects"');
		await control.$executeRawUnsafe('DROP FUNCTION IF EXISTS "ticket_005_wait_for_mutation_barrier"()');
		await control.$executeRawUnsafe('DROP TABLE IF EXISTS "ticket_005_mutation_barriers"');
		await control.orphanObject.deleteMany({ where: { bucket } });
		await control.project.deleteMany({ where: { id: { in: createdProjectIds } } });
		await control.exhibition.deleteMany({ where: { id: exhibitionId } });
		await control.user.deleteMany({ where: { id: userId } });
		await Promise.all([
			control.$disconnect(),
			barrierClient.$disconnect(),
			operationA.$disconnect(),
			operationB.$disconnect(),
		]);
	});

	it('repeats delete -> GAME replace with both critical sections inside PostgreSQL barriers', async () => {
		for (let iteration = 0; iteration < REPETITIONS; iteration += 1) {
			const project = await createProjectFixture();
			const oldKey = `integration/ticket-005/${testId}/delete-replace-${iteration}-old.zip`;
			const newKey = `integration/ticket-005/${testId}/delete-replace-${iteration}-new.zip`;
			const oldAsset = await createAssetFixture(project.id, 'GAME', oldKey);
			const objects = new Set([oldKey]);
			const deletion = createDeletionService(operationA, objects);
			const upload = createGameUploadService({ client: operationB, storageKey: newKey, objects });
			const barrier = await armBarrier('assets', oldAsset.id);
			let released = false;
			try {
				const deleting = deletion.deleteAsset(oldAsset.id, { id: userId, role: 'ADMIN' });
				await waitForDatabaseLock('ticket005-operation-a');
				const replacing = upload.service.addAssetToProject(
					project.id,
					exhibitionId,
					{ actor: { id: userId, role: 'ADMIN' }, parts: emptyParts() },
				);
				await waitForDatabaseLock('ticket005-operation-b');
				await barrier.release();
				released = true;
				await expect(Promise.all([deleting, replacing])).resolves.toHaveLength(2);
			} finally {
				if (!released) await barrier.release();
			}
			await Promise.all([deletion.drainDeletion(), upload.drainDeletion()]);

			await expect(control.asset.findUniqueOrThrow({ where: { id: oldAsset.id } }))
				.resolves.toMatchObject({ status: 'DELETED', storageKey: oldKey });
			const ready = await control.asset.findFirstOrThrow({
				where: { projectId: project.id, kind: 'GAME', status: 'READY' },
			});
			expect(ready.id).not.toBe(oldAsset.id);
			expect(ready.storageKey).toBe(newKey);
			expect(objects).toEqual(new Set([newKey]));
			await expectProjectInvariants(project.id, objects);
		}
	});

	it('repeats delete -> setPoster and rejects the stale poster winner', async () => {
		for (let iteration = 0; iteration < REPETITIONS; iteration += 1) {
			const project = await createProjectFixture();
			const key = `integration/ticket-005/${testId}/delete-poster-${iteration}.png`;
			const asset = await createAssetFixture(project.id, 'POSTER', key);
			const objects = new Set([key]);
			const deletion = createDeletionService(operationA, objects);
			const posterRepository = createProjectAssetMutationRepository(operationB);
			const barrier = await armBarrier('assets', asset.id);
			let released = false;
			let setPoster!: Promise<unknown>;
			try {
				const deleting = deletion.deleteAsset(asset.id, { id: userId, role: 'ADMIN' });
				await waitForDatabaseLock('ticket005-operation-a');
				setPoster = posterRepository.setProjectPoster(project.id, asset.id);
				await waitForDatabaseLock('ticket005-operation-b');
				await barrier.release();
				released = true;
				await expect(deleting).resolves.toEqual({ projectId: project.id });
			} finally {
				if (!released) await barrier.release();
			}
			await expect(setPoster).rejects.toMatchObject({ statusCode: 400 });
			await deletion.drainDeletion();
			await expect(control.project.findUniqueOrThrow({ where: { id: project.id } }))
				.resolves.toMatchObject({ posterAssetId: null });
			await expect(control.asset.findUniqueOrThrow({ where: { id: asset.id } }))
				.resolves.toMatchObject({ status: 'DELETED' });
			expect(objects.size).toBe(0);
			await expectProjectInvariants(project.id, objects);
		}
	});

	it('repeats setPoster -> status transition and clears the committed pointer by CAS', async () => {
		for (let iteration = 0; iteration < REPETITIONS; iteration += 1) {
			const project = await createProjectFixture();
			const key = `integration/ticket-005/${testId}/poster-status-${iteration}.png`;
			const asset = await createAssetFixture(project.id, 'IMAGE', key);
			const objects = new Set([key]);
			const posterRepository = createProjectAssetMutationRepository(operationA);
			const deletion = createDeletionService(operationB, objects);
			const barrier = await armBarrier('projects', project.id);
			let released = false;
			try {
				const setPoster = posterRepository.setProjectPoster(project.id, asset.id);
				await waitForDatabaseLock('ticket005-operation-a');
				const deleting = deletion.deleteAsset(asset.id, { id: userId, role: 'ADMIN' });
				await waitForDatabaseLock('ticket005-operation-b');
				await barrier.release();
				released = true;
				await expect(Promise.all([setPoster, deleting])).resolves.toHaveLength(2);
			} finally {
				if (!released) await barrier.release();
			}
			await deletion.drainDeletion();
			await expect(control.project.findUniqueOrThrow({ where: { id: project.id } }))
				.resolves.toMatchObject({ posterAssetId: null });
			await expect(control.asset.findUniqueOrThrow({ where: { id: asset.id } }))
				.resolves.toMatchObject({ status: 'DELETED' });
			expect(objects.size).toBe(0);
			await expectProjectInvariants(project.id, objects);
		}
	});

	it('commits deletion and its outbox before repeatable post-commit cleanup failures', async () => {
		for (let iteration = 0; iteration < REPETITIONS; iteration += 1) {
			const project = await createProjectFixture();
			const key = `integration/ticket-005/${testId}/double-failure-${iteration}.png`;
			const asset = await createAssetFixture(project.id, 'POSTER', key);
			await control.project.update({
				where: { id: project.id },
				data: { posterAssetId: asset.id },
			});
			const objects = new Set([key]);
			const failingDeletion = createDeletionService(operationA, objects, true);

			await expect(failingDeletion.deleteAsset(asset.id, { id: userId, role: 'ADMIN' }))
				.resolves.toEqual({ projectId: project.id });
			await failingDeletion.drainDeletion();
			await expect(control.asset.findUniqueOrThrow({ where: { id: asset.id } }))
				.resolves.toMatchObject({ status: 'DELETED', storageKey: key });
			await expect(control.project.findUniqueOrThrow({ where: { id: project.id } }))
				.resolves.toMatchObject({ posterAssetId: null });
			await expect(control.orphanObject.count({ where: { bucket, storageKey: key } }))
				.resolves.toBe(1);
			expect(objects.has(key)).toBe(true);

			await operationA.orphanObject.updateMany({
				where: { bucket, storageKey: key, resolvedAt: null },
				data: { nextAttemptAt: new Date(0), claimToken: null, claimUntil: null },
			});
			const retryDeletion = createDeletionService(operationA, objects);
			await expect(retryDeletion.deleteAsset(asset.id, { id: userId, role: 'ADMIN' }))
				.resolves.toEqual({ projectId: project.id });
			await retryDeletion.drainDeletion();
			await expect(control.asset.findUniqueOrThrow({ where: { id: asset.id } }))
				.resolves.toMatchObject({ status: 'DELETED' });
			await expect(control.orphanObject.count({ where: { bucket, storageKey: key, resolvedAt: null } }))
				.resolves.toBe(0);
			expect(objects.has(key)).toBe(false);
			await expectProjectInvariants(project.id, objects);
		}
	});

	it('durably cleans a losing GAME upload when bounded retry is exhausted', async () => {
		for (let iteration = 0; iteration < REPETITIONS; iteration += 1) {
			const project = await createProjectFixture();
			const oldKey = `integration/ticket-005/${testId}/loser-${iteration}-old.zip`;
			const winnerKey = `integration/ticket-005/${testId}/loser-${iteration}-winner.zip`;
			const loserKey = `integration/ticket-005/${testId}/loser-${iteration}-loser.zip`;
			const oldAsset = await createAssetFixture(project.id, 'GAME', oldKey);
			const objects = new Set([oldKey]);
			const winner = createGameUploadService({
				client: operationA,
				storageKey: winnerKey,
				objects,
				maxAttempts: 1,
			});
			const loser = createGameUploadService({
				client: operationB,
				storageKey: loserKey,
				objects,
				maxAttempts: 1,
			});
			const barrier = await armBarrier('assets', oldAsset.id);
			let released = false;
			let loserResult!: Promise<unknown>;
			try {
				const winnerResult = winner.service.addAssetToProject(
					project.id,
					exhibitionId,
					{ actor: { id: userId, role: 'ADMIN' }, parts: emptyParts() },
				);
				await waitForDatabaseLock('ticket005-operation-a');
				loserResult = loser.service.addAssetToProject(
					project.id,
					exhibitionId,
					{ actor: { id: userId, role: 'ADMIN' }, parts: emptyParts() },
				);
				await waitForDatabaseLock('ticket005-operation-b');
				await barrier.release();
				released = true;
				const [winnerOutcome, loserOutcome] = await Promise.allSettled([
					winnerResult,
					loserResult,
				]);
				if (winnerOutcome.status !== 'fulfilled') throw winnerOutcome.reason;
				expect(winnerOutcome.value.assetId).toBeGreaterThan(0);
				expect(loserOutcome).toMatchObject({
					status: 'rejected',
					reason: { statusCode: 409, code: 'CONFLICT' },
				});
			} finally {
				if (!released) await barrier.release();
			}
			await Promise.all([winner.drainDeletion(), loser.drainDeletion()]);
			expect(loser.rollback).toHaveBeenCalledOnce();
			expect(objects).toEqual(new Set([winnerKey]));
			await expect(control.asset.findUniqueOrThrow({ where: { id: oldAsset.id } }))
				.resolves.toMatchObject({ status: 'DELETED', storageKey: oldKey });
			await expect(control.asset.count({ where: { projectId: project.id, storageKey: loserKey } }))
				.resolves.toBe(0);
			await expectProjectInvariants(project.id, objects);
		}
	});
});
