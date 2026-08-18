import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createOrphanRepository } from '../modules/orphan/repository.js';
import { OBJECT_REFERENCE_CLAIM_LOCK_ID, type ObjectReferenceInventory } from '../modules/orphan/reference-resolver.js';
import { createOrphanService } from '../modules/orphan/service.js';
import { deferred } from './helpers/deferred.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';

const RENEWAL_POLICY = {
	statementTimeoutMs: 1_000,
	idleTransactionTimeoutMs: 1_100,
	transactionMaxWaitMs: 100,
	transactionTimeoutMs: 1_500,
};
const CLAIM_LEASE_MS = 30_000;
const BOUNDED_POOL_CONNECTION_TIMEOUT_MS = 1_000;
const EMPTY_INVENTORY: ObjectReferenceInventory = {
	references: [],
	unsafeBuckets: new Set<string>(),
};

function databaseUrlWithApplicationName(databaseUrl: string, applicationName: string): string {
	const parsed = new URL(databaseUrl);
	parsed.searchParams.set('application_name', applicationName);
	return parsed.toString();
}

async function waitFor(check: () => Promise<boolean>, message: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${message}`);
}

describe.runIf(runPostgresIntegration)('orphan renewal timeout uses bounded PostgreSQL statements', () => {
	const testId = randomUUID();
	const bucket = `orphan-renewal-timeout-${testId}`;
	// PostgreSQL truncates application_name at 63 bytes; keep the per-test name
	// short enough that pg_stat_activity matching stays exact.
	const applicationPrefix = `orphan-renewal-${testId.slice(0, 8)}`;
	let control: PrismaClient;
	let blocker: PrismaClient;
	let worker: PrismaClient;
	let boundedPoolWorker: PrismaClient;
	const createdIds: number[] = [];
	let sequence = 0;

	function applicationName(role: string) {
		return `${applicationPrefix}-${role}`;
	}

	function repository(client: PrismaClient) {
		return createOrphanRepository(client, { claimRenewalPolicy: RENEWAL_POLICY });
	}

	async function createClaim(input: { expiresAt?: Date; state?: 'PENDING' | 'DELETE_CLAIMED' } = {}) {
		sequence += 1;
		const token = `claim-token-${sequence}`;
		const state = input.state ?? 'DELETE_CLAIMED';
		const row = await control.orphanObject.create({
			data: {
				bucket,
				storageKey: `objects/${sequence}.bin`,
				reason: 'PostgreSQL renewal timeout regression',
				targetKind: 'EXACT',
				state,
				claimToken: state === 'DELETE_CLAIMED' ? token : null,
				claimUntil: state === 'DELETE_CLAIMED'
					? (input.expiresAt ?? new Date(Date.now() + 10_000))
					: null,
				nextAttemptAt: new Date(),
			},
		});
		createdIds.push(row.id);
		return { row, token };
	}

	async function activeAdvisoryWaits(application: string) {
		return control.$queryRaw<Array<{ pid: number; state: string; waitEventType: string | null; waitEvent: string | null }>>(Prisma.sql`
			SELECT pid, state, wait_event_type AS "waitEventType", wait_event AS "waitEvent"
			FROM pg_stat_activity
			WHERE application_name = ${application}
				AND state = 'active'
				AND wait_event_type = 'Lock'
				AND wait_event = 'advisory'
			ORDER BY pid
		`);
	}

	async function holdObjectReferenceLock() {
		const acquired = deferred();
		const releaseGate = deferred();
		const holder = blocker.$transaction(async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(${OBJECT_REFERENCE_CLAIM_LOCK_ID})`;
			acquired.resolve();
			await releaseGate.promise;
		}, { maxWait: 1_000, timeout: 5_000 });
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

	async function expectNoRenewalQuery(application: string) {
		await waitFor(async () => (await activeAdvisoryWaits(application)).length === 0,
			`${application} renewal query cleanup`);
	}

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
		control = createPrismaClientForDatabase(databaseUrlWithApplicationName(databaseUrl, applicationName('control')));
		blocker = createPrismaClientForDatabase(databaseUrlWithApplicationName(databaseUrl, applicationName('blocker')));
		worker = createPrismaClientForDatabase(databaseUrlWithApplicationName(databaseUrl, applicationName('worker')));
		boundedPoolWorker = new PrismaClient({
			adapter: new PrismaPg({
				connectionString: databaseUrlWithApplicationName(databaseUrl, applicationName('pool-3')),
				max: 3,
				connectionTimeoutMillis: BOUNDED_POOL_CONNECTION_TIMEOUT_MS,
				idleTimeoutMillis: 300_000,
			}, { schema: 'public' }),
		});
		await Promise.all([control.$connect(), blocker.$connect(), worker.$connect(), boundedPoolWorker.$connect()]);
	});

	afterAll(async () => {
		try {
			if (control) {
				await control.orphanObject.deleteMany({ where: { id: { in: createdIds } } });
				const activity = await control.$queryRaw<Array<{
					activeCount: bigint;
					idleTransactionCount: bigint;
				}>>(Prisma.sql`
					SELECT
						count(*) FILTER (WHERE state = 'active')::bigint AS "activeCount",
						count(*) FILTER (
							WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')
						)::bigint AS "idleTransactionCount"
					FROM pg_stat_activity
					WHERE application_name LIKE ${`${applicationPrefix}%`}
						AND application_name <> ${applicationName('control')}
				`);
				expect(activity[0]?.activeCount).toBe(0n);
				expect(activity[0]?.idleTransactionCount).toBe(0n);
			}
		} finally {
			await Promise.allSettled([
				control?.$disconnect(),
				blocker?.$disconnect(),
				worker?.$disconnect(),
				boundedPoolWorker?.$disconnect(),
			]);
		}
	});

	it('times out the actual blocked statement, removes it from pg_stat_activity, leaves no late lease mutation, and fails closed before storage', async () => {
		const { row, token } = await createClaim();
		const realRepository = repository(worker);
		const storage = {
			delete: vi.fn(async () => undefined),
			listKeyPage: vi.fn(async () => ({ keys: [], isTruncated: false })),
			deleteKeys: vi.fn(async () => ({ deleted: [], failures: [] })),
		};
		let renewalLock: Awaited<ReturnType<typeof holdObjectReferenceLock>> | undefined;
		const gatedRepository = {
			...realRepository,
			async claimPendingOrphans() {
				renewalLock = await holdObjectReferenceLock();
				return [{
					id: row.id,
					bucket: row.bucket,
					storageKey: row.storageKey,
					targetKind: 'EXACT' as const,
					attemptCount: row.attemptCount,
				}];
			},
		};
		const serviceWithRealRenewal = createOrphanService({
			clock: { now: () => new Date() },
			storage,
			repository: gatedRepository,
			references: { collect: async () => EMPTY_INVENTORY },
			ids: { next: () => token },
			logger: { info: vi.fn(), error: vi.fn() },
		});
		const reaper = serviceWithRealRenewal.runOrphanReaper();
		await waitFor(async () => (await activeAdvisoryWaits(applicationName('worker'))).length === 1,
			'production renewal statement to block on advisory lock');
		await expect(reaper).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
		await expectNoRenewalQuery(applicationName('worker'));
		expect(storage.delete).not.toHaveBeenCalled();
		expect(storage.listKeyPage).not.toHaveBeenCalled();
		expect(storage.deleteKeys).not.toHaveBeenCalled();
		await renewalLock?.release();
		const after = await control.orphanObject.findUniqueOrThrow({ where: { id: row.id } });
		expect(after.claimUntil).toBeNull(); // The failure transition, not a late renewal, owns this state.
	});

	it('keeps a timed-out direct renewal from mutating later and returns its connection to the pool', async () => {
		const { row, token } = await createClaim();
		const before = row.claimUntil!.getTime();
		const lock = await holdObjectReferenceLock();
		const renewal = repository(worker).renewActiveClaim(row.id, token, CLAIM_LEASE_MS);
		const renewalError = renewal.then(() => undefined, (error: unknown) => error);
		await waitFor(async () => (await activeAdvisoryWaits(applicationName('worker'))).length === 1,
			'direct renewal advisory wait');
		expect(String(await renewalError)).toMatch(/statement timeout/i);
		await expectNoRenewalQuery(applicationName('worker'));
		await lock.release();
		const afterRelease = await control.orphanObject.findUniqueOrThrow({ where: { id: row.id } });
		expect(afterRelease.claimUntil?.getTime()).toBe(before);
		await expect(worker.$queryRaw<Array<{ one: number }>>(Prisma.sql`SELECT 1 AS one`))
			.resolves.toEqual([{ one: 1 }]);
		await expect(repository(worker).renewActiveClaim(row.id, token, CLAIM_LEASE_MS))
			.resolves.toEqual({ count: 1 });
	});

	it('does not accumulate timed-out advisory waits or exhaust a bounded application pool', async () => {
		const lock = await holdObjectReferenceLock();
		const claims = await Promise.all([createClaim(), createClaim(), createClaim()]);
		const boundedRepository = repository(boundedPoolWorker);
		const renewals = claims.map(({ row, token }) => boundedRepository.renewActiveClaim(row.id, token, CLAIM_LEASE_MS));
		const renewalErrors = renewals.map((renewal) => renewal.then(() => undefined, (error: unknown) => error));
		await waitFor(async () => (await activeAdvisoryWaits(applicationName('pool-3'))).length === 3,
			'three real PostgreSQL renewal waiters using the three-slot pool');
		for (const error of await Promise.all(renewalErrors)) {
			expect(String(error)).toMatch(/statement timeout/i);
		}
		await expectNoRenewalQuery(applicationName('pool-3'));
		await lock.release();
		for (const { row } of claims) {
			const after = await control.orphanObject.findUniqueOrThrow({ where: { id: row.id } });
			expect(after.claimUntil?.getTime()).toBe(row.claimUntil!.getTime());
		}
		const probe = boundedPoolWorker.$queryRaw<Array<{ one: number }>>(Prisma.sql`SELECT 1 AS one`);
		// A leaked waiter would keep every slot checked out until the pool's own
		// 1s acquisition timeout rejects this query. After server cancellation,
		// this must complete before that acquisition boundary without depending on
		// a machine-specific sub-200ms latency target.
		await expect(Promise.race([
			probe,
			new Promise<never>((_resolve, reject) => setTimeout(
				() => reject(new Error('bounded pool did not recover before acquisition timeout')),
				BOUNDED_POOL_CONNECTION_TIMEOUT_MS - 50,
			)),
		])).resolves.toEqual([{ one: 1 }]);
	});

	it('rolls back a renewal that is aborted while waiting, even when the lock is released before statement timeout', async () => {
		const { row, token } = await createClaim();
		const before = row.claimUntil!.getTime();
		const lock = await holdObjectReferenceLock();
		const controller = new AbortController();
		const abortReason = new Error('test outer abort');
		const renewal = repository(worker).renewActiveClaim(row.id, token, CLAIM_LEASE_MS, {
			signal: controller.signal,
		});
		const renewalError = renewal.then(() => undefined, (error: unknown) => error);
		await waitFor(async () => (await activeAdvisoryWaits(applicationName('worker'))).length === 1,
			'abortable renewal advisory wait');
		controller.abort(abortReason);
		await lock.release();
		expect(await renewalError).toBe(abortReason);
		await expectNoRenewalQuery(applicationName('worker'));
		const after = await control.orphanObject.findUniqueOrThrow({ where: { id: row.id } });
		expect(after.claimUntil?.getTime()).toBe(before);
	});

	it('makes an outer service abort fail closed before storage while the real renewal is still bounded', async () => {
		const { row, token } = await createClaim();
		const realRepository = repository(worker);
		let renewalLock: Awaited<ReturnType<typeof holdObjectReferenceLock>> | undefined;
		const gatedRepository = {
			...realRepository,
			async claimPendingOrphans() {
				renewalLock = await holdObjectReferenceLock();
				return [{
					id: row.id,
					bucket: row.bucket,
					storageKey: row.storageKey,
					targetKind: 'EXACT' as const,
					attemptCount: row.attemptCount,
				}];
			},
		};
		const storage = {
			delete: vi.fn(async () => undefined),
			listKeyPage: vi.fn(async () => ({ keys: [], isTruncated: false })),
			deleteKeys: vi.fn(async () => ({ deleted: [], failures: [] })),
		};
		const controller = new AbortController();
		const service = createOrphanService({
			clock: { now: () => new Date() },
			storage,
			repository: gatedRepository,
			references: { collect: async () => EMPTY_INVENTORY },
			ids: { next: () => token },
			logger: { info: vi.fn(), error: vi.fn() },
		});
		const run = service.runOrphanReaper(controller.signal);
		await waitFor(async () => (await activeAdvisoryWaits(applicationName('worker'))).length === 1,
			'outer-aborted service renewal advisory wait');
		controller.abort(new Error('outer reaper abort'));
		const result = await Promise.race([
			run,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('service abort was not prompt')), 250)),
		]);
		expect(result).toEqual({ tried: 1, resolved: 0, failed: 1 });
		expect(storage.delete).not.toHaveBeenCalled();
		expect(storage.listKeyPage).not.toHaveBeenCalled();
		expect(storage.deleteKeys).not.toHaveBeenCalled();
		await renewalLock?.release();
		await expectNoRenewalQuery(applicationName('worker'));
	});
});
