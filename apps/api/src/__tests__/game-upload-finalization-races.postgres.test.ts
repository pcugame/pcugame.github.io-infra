import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createGameUploadRepository } from '../modules/admin/game-upload/repository.js';
import { createValidationWorker } from '../modules/admin/game-upload/validation-worker.service.js';
import { createMemberRepository } from '../modules/admin/member/repository.js';
import { createExhibitionRepository } from '../modules/admin/year/repository.js';
import { sourceIdentityRoot } from '../modules/admin/game-upload/source-identity.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const protectedBucket = 'pcu-protected';

function namedDatabaseUrl(databaseUrl: string, name: string): string {
	const parsed = new URL(databaseUrl);
	parsed.searchParams.set('application_name', name);
	return parsed.toString();
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function waitForDatabaseLock(
	observer: PrismaClient,
	applicationName: string,
): Promise<void> {
	await vi.waitFor(async () => {
		const waiting = await observer.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
			SELECT COUNT(*)::bigint AS "count"
			FROM pg_stat_activity
			WHERE application_name = ${applicationName}
				AND state = 'active'
				AND wait_event_type = 'Lock'
		`);
		expect(waiting[0]?.count).toBeGreaterThan(0n);
	}, { timeout: 10_000, interval: 25 });
}

describe.runIf(runPostgresIntegration)('GAME finalization authorization lock ordering', () => {
	let observer: PrismaClient;
	const clients: PrismaClient[] = [];

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required');
		observer = createPrismaClientForDatabase(namedDatabaseUrl(databaseUrl, 'finalization-race-observer'));
		await observer.$connect();
	});

	afterAll(async () => {
		await Promise.allSettled(clients.map((client) => client.$disconnect()));
		await observer?.$disconnect();
	});

	async function runRace(
		mutationKind: 'membership' | 'policy',
		first: 'finalization' | 'revocation',
	) {
		const databaseUrl = process.env['DATABASE_URL']!;
		const suffix = randomUUID();
		const finalizerName = `finalizer-${suffix}`;
		const mutationName = `revocation-${suffix}`;
		const blocker = createPrismaClientForDatabase(namedDatabaseUrl(databaseUrl, `blocker-${suffix}`));
		const finalizerClient = createPrismaClientForDatabase(namedDatabaseUrl(databaseUrl, finalizerName));
		const mutationClient = createPrismaClientForDatabase(namedDatabaseUrl(databaseUrl, mutationName));
		clients.push(blocker, finalizerClient, mutationClient);
		await Promise.all([blocker.$connect(), finalizerClient.$connect(), mutationClient.$connect()]);

		const creator = await observer.user.create({
			data: {
				googleSub: `race-creator-${suffix}`,
				email: `race-creator-${suffix}@example.test`,
				name: 'Race creator',
				role: 'USER',
			},
		});
		const actor = await observer.user.create({
			data: {
				googleSub: `race-actor-${suffix}`,
				email: `race-actor-${suffix}@example.test`,
				name: 'Race actor',
				role: 'USER',
			},
		});
		const exhibition = await observer.exhibition.create({
			data: { year: 2400 + Math.floor(Math.random() * 100_000), title: suffix, isUploadEnabled: true },
		});
		const project = await observer.project.create({
			data: {
				exhibitionId: exhibition.id,
				creatorId: creator.id,
				slug: `race-${suffix}`,
				title: 'Finalization race',
				status: 'PUBLISHED',
			},
		});
		const member = await observer.projectMember.create({
			data: {
				projectId: project.id,
				userId: actor.id,
				name: actor.name,
				studentId: `race-${suffix}`,
			},
		});
		const sourceKey = `race/${suffix}/source.zip`;
		const identityBlockSize = 1_048_576;
		const digest = createHash('sha256').update(Buffer.from([0])).digest('hex');
		const session = await observer.gameUploadSession.create({
			data: {
				id: suffix,
				projectId: project.id,
				userId: actor.id,
				uploadKind: 'GAME',
				originalName: 'game.zip',
				totalBytes: 1n,
				chunkSizeBytes: identityBlockSize,
				totalChunks: 1,
				sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
				sourceIdentity: sourceIdentityRoot(1, identityBlockSize, [digest]),
				sourceIdentityBlockSizeBytes: identityBlockSize,
				sourceIdentityBlockManifest: Buffer.from(digest, 'hex'),
				status: 'VERIFYING',
				s3Key: sourceKey,
				s3UploadId: null,
				storageKey: sourceKey,
				expectedTargetAssetId: null,
				expectedTargetAssetUpdatedAt: null,
				expiresAt: new Date('2099-01-01T00:00:00.000Z'),
			},
		});
		await observer.gameUploadActiveSession.create({
			data: { projectId: project.id, uploadKind: 'GAME', sessionId: session.id },
		});

		const repository = createGameUploadRepository(finalizerClient, {
			abortBucket: protectedBucket,
		});
		const processorStarted = deferred();
		const worker = createValidationWorker({
			repository,
			ids: { next: () => `claim-${suffix}` },
			processor: {
				async process(claimed, context) {
					processorStarted.resolve();
					await repository.finalizeCompletedSession(
						claimed.id,
						project.id,
						'GAME',
						{
							storageKey: sourceKey,
							originalName: 'game.zip',
							mimeType: 'application/zip',
							sizeBytes: 1n,
							isPublic: false,
							completionClaimToken: context.claimToken,
						},
						{
							bucket: protectedBucket,
							reason: 'replace-game',
							playbackReason: 'replace-game-playback',
						},
					);
				},
			},
			wakeDeletionWorker: vi.fn(),
			logger: { info: vi.fn(), error: vi.fn() },
			options: { concurrency: 1, claimLeaseMs: 120_000 },
		});
		const releaseBlocker = deferred();
		const blockerAcquired = deferred();
		const blockedTable = mutationKind === 'membership' ? 'projects' : 'exhibitions';
		const blockedId = mutationKind === 'membership' ? project.id : exhibition.id;
		const blockerTransaction = blocker.$transaction(async (tx) => {
			await tx.$queryRaw(Prisma.sql`
				SELECT "id" FROM ${Prisma.raw(`"${blockedTable}"`)}
				WHERE "id" = ${blockedId}
				FOR UPDATE
			`);
			blockerAcquired.resolve();
			await releaseBlocker.promise;
		}, { timeout: 20_000 });
		await blockerAcquired.promise;

		const mutate = async (): Promise<unknown> => {
			if (mutationKind === 'membership') {
				return createMemberRepository(mutationClient).deleteMember(member.id, project.id);
			}
			return createExhibitionRepository(mutationClient).updateExhibition(
				exhibition.id,
				{ isUploadEnabled: false },
			);
		};
		let workerRun!: Promise<Awaited<ReturnType<typeof worker.runPass>>>;
		let mutation!: Promise<unknown>;
		try {
			if (first === 'finalization') {
				workerRun = worker.runPass();
				await processorStarted.promise;
				await waitForDatabaseLock(observer, finalizerName);
				mutation = Promise.resolve().then(mutate);
				await waitForDatabaseLock(observer, mutationName);
			} else {
				mutation = Promise.resolve().then(mutate);
				await waitForDatabaseLock(observer, mutationName);
				workerRun = worker.runPass();
				await processorStarted.promise;
				await waitForDatabaseLock(observer, finalizerName);
			}
			releaseBlocker.resolve();
			await blockerTransaction;
			const [workerResult] = await Promise.all([workerRun, mutation]);
			if (first === 'finalization') {
				expect(workerResult).toEqual({ claimed: 1, ready: 1, rejected: 0, retried: 0 });
				await expect(observer.gameUploadSession.findUniqueOrThrow({ where: { id: session.id } }))
					.resolves.toMatchObject({ status: 'COMPLETED' });
				await expect(observer.asset.findFirstOrThrow({ where: { storageKey: sourceKey } }))
					.resolves.toMatchObject({ status: 'READY' });
			} else {
				expect(workerResult).toEqual({ claimed: 1, ready: 0, rejected: 1, retried: 0 });
				await expect(observer.gameUploadSession.findUniqueOrThrow({ where: { id: session.id } }))
					.resolves.toMatchObject({ status: 'REJECTED', completionClaimToken: null });
				await expect(observer.asset.count({ where: { storageKey: sourceKey } })).resolves.toBe(0);
				await expect(observer.orphanObject.findUniqueOrThrow({
					where: { orphan_bucket_storage_key: { bucket: protectedBucket, storageKey: sourceKey } },
				})).resolves.toMatchObject({ state: 'PENDING', targetKind: 'EXACT' });
			}
			await expect(observer.gameUploadActiveSession.findUnique({
				where: { projectId_uploadKind: { projectId: project.id, uploadKind: 'GAME' } },
			})).resolves.toBeNull();
		} finally {
			releaseBlocker.resolve();
			await blockerTransaction.catch(() => undefined);
			await observer.gameUploadActiveSession.deleteMany({ where: { sessionId: session.id } });
			await observer.orphanObject.deleteMany({ where: { bucket: protectedBucket, storageKey: sourceKey } });
			await observer.asset.deleteMany({ where: { projectId: project.id } });
			await observer.gameUploadSession.deleteMany({ where: { id: session.id } });
			await observer.projectMember.deleteMany({ where: { projectId: project.id } });
			await observer.project.deleteMany({ where: { id: project.id } });
			await observer.exhibition.deleteMany({ where: { id: exhibition.id } });
			await observer.user.deleteMany({ where: { id: { in: [actor.id, creator.id] } } });
		}
	}

	it.each([
		['membership', 'finalization'],
		['membership', 'revocation'],
		['policy', 'finalization'],
		['policy', 'revocation'],
	] as const)('%s mutation and finalization are ordered when %s queues first', async (kind, first) => {
		await runRace(kind, first);
	}, 30_000);
});
