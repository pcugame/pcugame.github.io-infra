import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createObjectDeletionCoordinator } from '../application/object-deletion.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createOrphanRepository } from '../modules/orphan/repository.js';
import { createOrphanService } from '../modules/orphan/service.js';
import { createObjectReferenceResolver } from '../modules/orphan/reference-resolver.js';
import {
	EXHIBITION_MUTATION_TRANSACTION_POLICY,
	createExhibitionRepository,
} from '../modules/admin/year/repository.js';
import { createExhibitionService } from '../modules/admin/year/service.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const BARRIER_NAMESPACE = 50_090;
const REPETITIONS = 3;

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

describe.runIf(runPostgresIntegration)('year poster concurrency with PostgreSQL barriers', () => {
	let control: PrismaClient;
	let barrierClient: PrismaClient;
	let operationA: PrismaClient;
	let operationB: PrismaClient;
	let fixtureSequence = 0;
	let barrierSequence = 90_000;
	const testId = randomUUID();
	const bucket = `ticket-009-${testId}`;
	const createdExhibitionIds: number[] = [];

	async function createExhibitionFixture(label: string) {
		fixtureSequence += 1;
		const oldKey = `integration/ticket-009/${testId}/${label}-${fixtureSequence}-old.webp`;
		const exhibition = await control.exhibition.create({
			data: {
				year: 2400 + fixtureSequence,
				title: `Ticket 009 ${testId} ${fixtureSequence}`,
				posterStorageKey: oldKey,
				posterOriginalName: 'old.webp',
				posterMimeType: 'image/webp',
				posterSizeBytes: 8n,
			},
		});
		createdExhibitionIds.push(exhibition.id);
		return { exhibition, oldKey };
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

	async function armBarrier(exhibitionId: number) {
		barrierSequence += 1;
		const barrierKey = barrierSequence;
		await control.$executeRaw`
			INSERT INTO "ticket_009_poster_barriers" ("exhibition_id", "barrier_key")
			VALUES (${exhibitionId}, ${barrierKey})
			ON CONFLICT ("exhibition_id")
			DO UPDATE SET "barrier_key" = EXCLUDED."barrier_key"
		`;
		const acquired = deferred();
		const releaseGate = deferred();
		const holder = barrierClient.$transaction(async (tx) => {
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
				await control.$executeRaw`
					DELETE FROM "ticket_009_poster_barriers"
					WHERE "exhibition_id" = ${exhibitionId}
				`;
			},
		};
	}

	function serviceHarness(input: {
		client: PrismaClient;
		uploadKey: string;
		objects: Set<string>;
		failDelete?: Set<string>;
		maxAttempts?: number;
		onRetry?: () => void;
	}) {
		const orphanService = createOrphanService({
			clock: { now: () => new Date('2026-07-24T00:00:00.000Z') },
			storage: {
				async delete(_bucket, key) {
					if (input.failDelete?.has(key)) throw new Error(`storage delete failed: ${key}`);
					input.objects.delete(key);
				},
				listKeys: vi.fn(async () => []),
			},
			repository: createOrphanRepository(input.client),
			references: createObjectReferenceResolver(
				input.client,
				{ publicBucket: bucket, protectedBucket: bucket },
				{ error: vi.fn() },
			),
			logger: {
				info: vi.fn(),
				error: vi.fn(),
			},
		});
		const deletion = createObjectDeletionCoordinator({
			storage: {
				async delete(_bucket, key) {
					if (input.failDelete?.has(key)) throw new Error(`storage delete failed: ${key}`);
					input.objects.delete(key);
				},
				listKeys: vi.fn(async () => []),
			},
			orphans: { record: orphanService.recordOrphan },
			logger: { error: vi.fn() },
		});
		const rollback = vi.fn(async () => deletion.deleteOrQueue(
			bucket,
			input.uploadKey,
			'ticket-009-unpersisted-upload',
		));
		const cleanup = vi.fn(async () => {});
		const repository = createExhibitionRepository(input.client, {
			...EXHIBITION_MUTATION_TRANSACTION_POLICY,
			maxAttempts: input.maxAttempts ?? EXHIBITION_MUTATION_TRANSACTION_POLICY.maxAttempts,
			onRetry: input.onRetry ? () => input.onRetry?.() : undefined,
		});
		const service = createExhibitionService({
			apiPublicUrl: 'https://api.example.test',
			posterBucket: bucket,
			repository,
			uploadLimits: () => ({
				posterMaxBytes: 1024,
				imageMaxBytes: 1024,
				gameMaxBytes: 1024,
				videoMaxBytes: 1024,
				requestMaxBytes: 1024,
				maxFiles: 1,
			}),
			uploadSlots: { acquire: vi.fn(), release: vi.fn() },
			posterUpload: {
				start: async () => {
					input.objects.add(input.uploadKey);
					return {
						savedFile: {
							storageKey: input.uploadKey,
							mimeType: 'image/webp',
							sizeBytes: 16,
							originalName: 'new.webp',
							kind: 'POSTER' as const,
						},
						rollback,
						cleanup,
					};
				},
			},
			wakeDeletionWorker: vi.fn(),
		});
		return { service, rollback, cleanup };
	}

	async function assertDeletedOrDurable(key: string, objects: Set<string>) {
		if (!objects.has(key)) return;
		await expect(control.orphanObject.count({
			where: { bucket, storageKey: key, resolvedAt: null },
		})).resolves.toBeGreaterThan(0);
	}

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
		control = createPrismaClientForDatabase(databaseUrlWithApplicationName(databaseUrl, 'ticket009-control'));
		barrierClient = createPrismaClientForDatabase(databaseUrlWithApplicationName(databaseUrl, 'ticket009-holder'));
		operationA = createPrismaClientForDatabase(databaseUrlWithApplicationName(databaseUrl, 'ticket009-operation-a'));
		operationB = createPrismaClientForDatabase(databaseUrlWithApplicationName(databaseUrl, 'ticket009-operation-b'));
		await Promise.all([
			control.$connect(),
			barrierClient.$connect(),
			operationA.$connect(),
			operationB.$connect(),
		]);
		await control.$executeRawUnsafe(`
			CREATE TABLE IF NOT EXISTS "ticket_009_poster_barriers" (
				"exhibition_id" integer PRIMARY KEY,
				"barrier_key" integer NOT NULL
			)
		`);
		await control.$executeRawUnsafe('TRUNCATE TABLE "ticket_009_poster_barriers"');
		await control.$executeRawUnsafe(`
			CREATE OR REPLACE FUNCTION "ticket_009_wait_for_poster_barrier"()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $function$
			DECLARE selected_key integer;
			BEGIN
				SELECT "barrier_key" INTO selected_key
				FROM "ticket_009_poster_barriers"
				WHERE "exhibition_id" = NEW."id";
				IF selected_key IS NOT NULL THEN
					PERFORM pg_advisory_xact_lock(${BARRIER_NAMESPACE}, selected_key);
				END IF;
				RETURN NEW;
			END
			$function$
		`);
		await control.$executeRawUnsafe('DROP TRIGGER IF EXISTS "ticket_009_exhibition_barrier" ON "exhibitions"');
		await control.$executeRawUnsafe(`
			CREATE TRIGGER "ticket_009_exhibition_barrier"
			BEFORE UPDATE ON "exhibitions"
			FOR EACH ROW EXECUTE FUNCTION "ticket_009_wait_for_poster_barrier"()
		`);
		await control.$executeRawUnsafe('CREATE SEQUENCE IF NOT EXISTS "ticket_009_serialization_retry_sequence"');
		await control.$executeRawUnsafe(`
			CREATE OR REPLACE FUNCTION "ticket_009_force_serialization_conflict"()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $function$
			BEGIN
				IF NEW."poster_storage_key" LIKE '%force-serialization-exhausted%' THEN
					RAISE EXCEPTION 'ticket 009 forced serialization exhaustion' USING ERRCODE = '40001';
				END IF;
				IF NEW."poster_storage_key" LIKE '%force-serialization-retry%'
					AND nextval('ticket_009_serialization_retry_sequence') % 2 = 1 THEN
					RAISE EXCEPTION 'ticket 009 forced serialization retry' USING ERRCODE = '40001';
				END IF;
				RETURN NEW;
			END
			$function$
		`);
		await control.$executeRawUnsafe('DROP TRIGGER IF EXISTS "ticket_009_serialization_conflict" ON "exhibitions"');
		await control.$executeRawUnsafe(`
			CREATE TRIGGER "ticket_009_serialization_conflict"
			BEFORE UPDATE ON "exhibitions"
			FOR EACH ROW EXECUTE FUNCTION "ticket_009_force_serialization_conflict"()
		`);
		await control.$executeRawUnsafe(`
			CREATE OR REPLACE FUNCTION "ticket_009_fail_selected_outbox"()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $function$
			BEGIN
				IF NEW."storage_key" LIKE '%force-outbox-failure%' THEN
					RAISE EXCEPTION 'ticket 009 forced outbox failure';
				END IF;
				RETURN NEW;
			END
			$function$
		`);
		await control.$executeRawUnsafe('DROP TRIGGER IF EXISTS "ticket_009_outbox_failure" ON "orphan_objects"');
		await control.$executeRawUnsafe(`
			CREATE TRIGGER "ticket_009_outbox_failure"
			BEFORE INSERT OR UPDATE ON "orphan_objects"
			FOR EACH ROW EXECUTE FUNCTION "ticket_009_fail_selected_outbox"()
		`);
	});

	afterAll(async () => {
		if (!control) return;
		await control.$executeRawUnsafe('DROP TRIGGER IF EXISTS "ticket_009_exhibition_barrier" ON "exhibitions"');
		await control.$executeRawUnsafe('DROP FUNCTION IF EXISTS "ticket_009_wait_for_poster_barrier"()');
		await control.$executeRawUnsafe('DROP TABLE IF EXISTS "ticket_009_poster_barriers"');
		await control.$executeRawUnsafe('DROP TRIGGER IF EXISTS "ticket_009_serialization_conflict" ON "exhibitions"');
		await control.$executeRawUnsafe('DROP FUNCTION IF EXISTS "ticket_009_force_serialization_conflict"()');
		await control.$executeRawUnsafe('DROP SEQUENCE IF EXISTS "ticket_009_serialization_retry_sequence"');
		await control.$executeRawUnsafe('DROP TRIGGER IF EXISTS "ticket_009_outbox_failure" ON "orphan_objects"');
		await control.$executeRawUnsafe('DROP FUNCTION IF EXISTS "ticket_009_fail_selected_outbox"()');
		await control.orphanObject.deleteMany({ where: { bucket } });
		await control.exhibition.deleteMany({ where: { id: { in: createdExhibitionIds } } });
		await Promise.all([
			control.$disconnect(),
			barrierClient.$disconnect(),
			operationA.$disconnect(),
			operationB.$disconnect(),
		]);
	});

	it('repeats replace -> replace with observable overlap and bounded serialization retry', async () => {
		for (let iteration = 0; iteration < REPETITIONS; iteration += 1) {
			const { exhibition, oldKey } = await createExhibitionFixture(`replace-replace-${iteration}`);
			const firstKey = `integration/ticket-009/${testId}/replace-replace-${iteration}-first.webp`;
			const winnerKey = `integration/ticket-009/${testId}/replace-replace-${iteration}-winner.webp`;
			const objects = new Set([oldKey]);
			const first = serviceHarness({ client: operationA, uploadKey: firstKey, objects });
			const winner = serviceHarness({
				client: operationB,
				uploadKey: winnerKey,
				objects,
			});
			const barrier = await armBarrier(exhibition.id);
			let released = false;
			try {
				const replacingFirst = first.service.replacePoster(exhibition.id, {
					actor: { id: 1, role: 'ADMIN' },
					parts: emptyParts(),
				});
				await waitForDatabaseLock('ticket009-operation-a');
				const replacingWinner = winner.service.replacePoster(exhibition.id, {
					actor: { id: 1, role: 'ADMIN' },
					parts: emptyParts(),
				});
				await waitForDatabaseLock('ticket009-operation-b');
				await barrier.release();
				released = true;
				await expect(Promise.all([replacingFirst, replacingWinner])).resolves.toHaveLength(2);
			} finally {
				if (!released) await barrier.release();
			}

			await expect(control.exhibition.findUniqueOrThrow({ where: { id: exhibition.id } }))
				.resolves.toMatchObject({ posterStorageKey: winnerKey });
			expect(objects.has(winnerKey)).toBe(true);
			expect(await control.orphanObject.count({
				where: { bucket, storageKey: winnerKey, resolvedAt: null },
			})).toBe(0);
			await assertDeletedOrDurable(oldKey, objects);
			await assertDeletedOrDurable(firstKey, objects);
		}
	});

	it('repeats replace -> clear with both critical sections overlapping', async () => {
		for (let iteration = 0; iteration < REPETITIONS; iteration += 1) {
			const { exhibition, oldKey } = await createExhibitionFixture(`replace-then-clear-${iteration}`);
			const newKey = `integration/ticket-009/${testId}/replace-clear-${iteration}-new.webp`;
			const objects = new Set([oldKey]);
			const replacement = serviceHarness({
				client: operationA,
				uploadKey: newKey,
				objects,
			});
			const clearing = serviceHarness({
				client: operationB,
				uploadKey: newKey,
				objects,
			});
			const barrier = await armBarrier(exhibition.id);
			let released = false;
			try {
				const replacing = replacement.service.replacePoster(exhibition.id, {
					actor: { id: 1, role: 'ADMIN' },
					parts: emptyParts(),
				});
				await waitForDatabaseLock('ticket009-operation-a');
				const clearingPoster = clearing.service.deletePoster(exhibition.id);
				await waitForDatabaseLock('ticket009-operation-b');
				await barrier.release();
				released = true;
				await expect(Promise.all([replacing, clearingPoster])).resolves.toHaveLength(2);
			} finally {
				if (!released) await barrier.release();
			}

			const row = await control.exhibition.findUniqueOrThrow({ where: { id: exhibition.id } });
			expect(row.posterStorageKey).toBeNull();
			await expect(control.orphanObject.count({
				where: { bucket, storageKey: oldKey, resolvedAt: null },
			})).resolves.toBe(1);
			await expect(control.orphanObject.count({
				where: { bucket, storageKey: newKey, resolvedAt: null },
			})).resolves.toBe(1);
			await assertDeletedOrDurable(newKey, objects);
			await assertDeletedOrDurable(oldKey, objects);
		}
	});

	it('repeats clear -> replace with both critical sections overlapping', async () => {
		for (let iteration = 0; iteration < REPETITIONS; iteration += 1) {
			const { exhibition, oldKey } = await createExhibitionFixture(`clear-then-replace-${iteration}`);
			const newKey = `integration/ticket-009/${testId}/clear-replace-${iteration}-new.webp`;
			const objects = new Set([oldKey]);
			const clearing = serviceHarness({
				client: operationA,
				uploadKey: newKey,
				objects,
			});
			const replacement = serviceHarness({
				client: operationB,
				uploadKey: newKey,
				objects,
			});
			const barrier = await armBarrier(exhibition.id);
			let released = false;
			try {
				const clearingPoster = clearing.service.deletePoster(exhibition.id);
				await waitForDatabaseLock('ticket009-operation-a');
				const replacing = replacement.service.replacePoster(exhibition.id, {
					actor: { id: 1, role: 'ADMIN' },
					parts: emptyParts(),
				});
				await waitForDatabaseLock('ticket009-operation-b');
				await barrier.release();
				released = true;
				await expect(Promise.all([clearingPoster, replacing])).resolves.toHaveLength(2);
			} finally {
				if (!released) await barrier.release();
			}

			const row = await control.exhibition.findUniqueOrThrow({ where: { id: exhibition.id } });
			expect(row.posterStorageKey).toBe(newKey);
			expect(objects.has(newKey)).toBe(true);
			await expect(control.orphanObject.count({
				where: { bucket, storageKey: oldKey, resolvedAt: null },
			})).resolves.toBe(1);
			await expect(control.orphanObject.count({
				where: { bucket, storageKey: newKey, resolvedAt: null },
			})).resolves.toBe(0);
			await assertDeletedOrDurable(oldKey, objects);
		}
	});

	it('retries a real PostgreSQL 40001 without uploading or queueing the winner twice', async () => {
		await control.$executeRawUnsafe(
			'ALTER SEQUENCE "ticket_009_serialization_retry_sequence" RESTART WITH 1',
		);
		const { exhibition, oldKey } = await createExhibitionFixture('serialization-retry');
		const newKey = `integration/ticket-009/${testId}/force-serialization-retry-winner.webp`;
		const objects = new Set([oldKey]);
		let retryCount = 0;
		const service = serviceHarness({
			client: operationA,
			uploadKey: newKey,
			objects,
			onRetry: () => { retryCount += 1; },
		});

		await expect(service.service.replacePoster(exhibition.id, {
			actor: { id: 1, role: 'ADMIN' },
			parts: emptyParts(),
		})).resolves.toMatchObject({ posterUrl: expect.stringContaining(newKey) });
		await expect(control.exhibition.findUniqueOrThrow({ where: { id: exhibition.id } }))
			.resolves.toMatchObject({ posterStorageKey: newKey });
		const sequence = await control.$queryRaw<Array<{ lastValue: bigint }>>`
			SELECT last_value AS "lastValue"
			FROM "ticket_009_serialization_retry_sequence"
		`;
		expect({ retryCount, sequence: Number(sequence[0]?.lastValue) }).toEqual({
			retryCount: 1,
			sequence: 2,
		});
		expect(objects.has(newKey)).toBe(true);
		expect(service.rollback).not.toHaveBeenCalled();
		await expect(control.orphanObject.count({
			where: { bucket, storageKey: oldKey, resolvedAt: null },
		})).resolves.toBe(1);
		await expect(control.orphanObject.count({
			where: { bucket, storageKey: newKey, resolvedAt: null },
		})).resolves.toBe(0);
	});

	it('durably removes the losing upload when bounded retry is exhausted', async () => {
		const { exhibition, oldKey } = await createExhibitionFixture('retry-exhausted');
		const winnerKey = `integration/ticket-009/${testId}/retry-exhausted-winner.webp`;
		const loserKey = `integration/ticket-009/${testId}/force-serialization-exhausted-loser.webp`;
		const objects = new Set([oldKey]);
		const winner = serviceHarness({ client: operationA, uploadKey: winnerKey, objects });
		const loser = serviceHarness({
			client: operationB,
			uploadKey: loserKey,
			objects,
			maxAttempts: 1,
		});
		const barrier = await armBarrier(exhibition.id);
		let released = false;
		try {
			const winning = winner.service.replacePoster(exhibition.id, {
				actor: { id: 1, role: 'ADMIN' },
				parts: emptyParts(),
			});
			await waitForDatabaseLock('ticket009-operation-a');
			const losing = loser.service.replacePoster(exhibition.id, {
				actor: { id: 1, role: 'ADMIN' },
				parts: emptyParts(),
			});
			await waitForDatabaseLock('ticket009-operation-b');
			await barrier.release();
			released = true;
			await expect(winning).resolves.toMatchObject({ posterUrl: expect.stringContaining(winnerKey) });
			await expect(losing).rejects.toMatchObject({ statusCode: 409 });
		} finally {
			if (!released) await barrier.release();
		}

		await expect(control.exhibition.findUniqueOrThrow({ where: { id: exhibition.id } }))
			.resolves.toMatchObject({ posterStorageKey: winnerKey });
		expect(objects.has(winnerKey)).toBe(true);
		await assertDeletedOrDurable(oldKey, objects);
		await assertDeletedOrDurable(loserKey, objects);
		expect(loser.rollback).toHaveBeenCalledOnce();
	});

	it('retains a durable old-key outbox when post-commit storage cleanup fails', async () => {
		const { exhibition, oldKey } = await createExhibitionFixture('cleanup-failure');
		const newKey = `integration/ticket-009/${testId}/cleanup-failure-new.webp`;
		const objects = new Set([oldKey]);
		const service = serviceHarness({
			client: operationA,
			uploadKey: newKey,
			objects,
			failDelete: new Set([oldKey]),
		});

		await expect(service.service.replacePoster(exhibition.id, {
			actor: { id: 1, role: 'ADMIN' },
			parts: emptyParts(),
		})).resolves.toMatchObject({ posterUrl: expect.stringContaining(newKey) });
		await expect(control.exhibition.findUniqueOrThrow({ where: { id: exhibition.id } }))
			.resolves.toMatchObject({ posterStorageKey: newKey });
		expect(objects.has(newKey)).toBe(true);
		expect(objects.has(oldKey)).toBe(true);
		await expect(control.orphanObject.count({
			where: { bucket, storageKey: oldKey, resolvedAt: null },
		})).resolves.toBe(1);
	});

	it('rolls back an uploaded object after outbox/DB failure and surfaces double cleanup failure', async () => {
		const { exhibition, oldKey } = await createExhibitionFixture('force-outbox-failure-old');
		const newKey = `integration/ticket-009/${testId}/force-outbox-failure-new.webp`;
		const objects = new Set([oldKey]);
		const rollback = serviceHarness({
			client: operationA,
			uploadKey: newKey,
			objects,
		});

		await expect(rollback.service.replacePoster(exhibition.id, {
			actor: { id: 1, role: 'ADMIN' },
			parts: emptyParts(),
		})).rejects.toThrow(/ticket 009 forced outbox failure/i);
		await expect(control.exhibition.findUniqueOrThrow({ where: { id: exhibition.id } }))
			.resolves.toMatchObject({ posterStorageKey: oldKey });
		expect(objects.has(newKey)).toBe(false);
		expect(rollback.rollback).toHaveBeenCalledOnce();

		const doubleFailureKey = `integration/ticket-009/${testId}/force-outbox-failure-double.webp`;
		const doubleFailure = serviceHarness({
			client: operationA,
			uploadKey: doubleFailureKey,
			objects,
			failDelete: new Set([doubleFailureKey]),
		});
		await expect(doubleFailure.service.replacePoster(exhibition.id, {
			actor: { id: 1, role: 'ADMIN' },
			parts: emptyParts(),
		})).rejects.toThrow(/deletion and durable orphan recording both failed/i);
		await expect(control.exhibition.findUniqueOrThrow({ where: { id: exhibition.id } }))
			.resolves.toMatchObject({ posterStorageKey: oldKey });
		expect(objects.has(doubleFailureKey)).toBe(true);
		expect(doubleFailure.rollback).toHaveBeenCalledOnce();
	});
});
