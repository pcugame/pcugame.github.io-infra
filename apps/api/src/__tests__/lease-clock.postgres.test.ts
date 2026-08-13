import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import {
	createIdempotencyRepository,
	succeedIdempotencyOperation,
} from '../modules/idempotency/repository.js';
import { createIdempotencyService } from '../modules/idempotency/service.js';
import { createMultipartAbortRepository } from '../modules/multipart-abort/repository.js';
import { createMultipartAbortService } from '../modules/multipart-abort/service.js';
import { createUploadIntentRepository } from '../modules/upload-intent/repository.js';
import { createUploadIntentService } from '../modules/upload-intent/service.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const FAR_PAST = new Date('2000-01-01T00:00:00.000Z');
const FAR_FUTURE = new Date('9990-01-01T00:00:00.000Z');

async function expectDatabaseLeaseDeadline(
	client: PrismaClient,
	deadline: Date,
	minimumRemainingMs: number,
	maximumRemainingMs: number,
): Promise<void> {
	const [databaseTime] = await client.$queryRaw<Array<{ now: Date }>>`
		SELECT clock_timestamp() AS "now"
	`;
	if (!databaseTime) throw new Error('PostgreSQL did not return its clock');
	const remainingMs = deadline.getTime() - databaseTime.now.getTime();
	expect(remainingMs).toBeGreaterThan(minimumRemainingMs);
	expect(remainingMs).toBeLessThan(maximumRemainingMs);
}

describe.runIf(runPostgresIntegration)(
	'DB-clock ownership leases with production PostgreSQL repositories',
	() => {
		const testId = randomUUID();
		const bucket = `lease-clock-${testId}`;
		let control: PrismaClient;
		let firstWorker: PrismaClient;
		let secondWorker: PrismaClient;
		let actorId: number;

		beforeAll(async () => {
			const databaseUrl = process.env['DATABASE_URL'];
			if (!databaseUrl) throw new Error('DATABASE_URL is required');
			control = createPrismaClientForDatabase(databaseUrl);
			firstWorker = createPrismaClientForDatabase(databaseUrl);
			secondWorker = createPrismaClientForDatabase(databaseUrl);
			await Promise.all([
				control.$connect(),
				firstWorker.$connect(),
				secondWorker.$connect(),
			]);
			const actor = await control.user.create({
				data: {
					googleSub: `lease-clock-${testId}`,
					email: `lease-clock-${testId}@example.test`,
					name: 'Lease clock integration',
					role: 'ADMIN',
				},
			});
			actorId = actor.id;
		});

		afterAll(async () => {
			if (!control) return;
			await control.orphanObject.deleteMany({ where: { bucket } });
			await control.uploadIntent.deleteMany({ where: { bucket } });
			await control.multipartAbortTask.deleteMany({ where: { bucket } });
			await control.idempotencyOperation.deleteMany({ where: { actorId } });
			await control.user.deleteMany({ where: { id: actorId } });
			await Promise.all([
				control.$disconnect(),
				firstWorker.$disconnect(),
				secondWorker.$disconnect(),
			]);
		});

		it('uses PostgreSQL time for upload-intent takeover and fences every stale final mutation', async () => {
			const id = randomUUID();
			const storageKey = `${testId}/upload-intent.bin`;
			const ownerToken = randomUUID();
			const takeoverToken = randomUUID();
			const owner = createUploadIntentRepository(firstWorker);
			const contender = createUploadIntentRepository(secondWorker);
			await owner.prepare({
				id,
				bucket,
				storageKey,
				purpose: 'lease-clock-regression',
				notBefore: FAR_PAST,
			});

			await expect(owner.claimStale(1, ownerToken, 60_000)).resolves.toEqual([
				expect.objectContaining({ id }),
			]);
			const firstDeadline = (await control.uploadIntent.findUniqueOrThrow({
				where: { id },
			})).claimUntil!;
			await expectDatabaseLeaseDeadline(control, firstDeadline, 30_000, 90_000);
			const referenceSnapshot = vi.fn();
			const futureClockWorker = createUploadIntentService({
				repository: contender,
				references: { collect: referenceSnapshot },
				storage: { head: vi.fn() },
				clock: { now: () => FAR_FUTURE },
				ids: { next: () => takeoverToken },
				logger: { info: vi.fn(), error: vi.fn() },
				graceMs: 0,
			});
			await expect(futureClockWorker.sweep()).resolves.toEqual({
				tried: 0,
				referenced: 0,
				queued: 0,
				missing: 0,
			});
			expect(referenceSnapshot).not.toHaveBeenCalled();

			await expect(contender.renewClaim(id, 'wrong-token', 180_000))
				.resolves.toEqual({ count: 0 });
			await expect(owner.renewClaim(id, ownerToken, 180_000))
				.resolves.toEqual({ count: 1 });
			const renewedDeadline = (await control.uploadIntent.findUniqueOrThrow({
				where: { id },
			})).claimUntil!;
			expect(renewedDeadline.getTime()).toBeGreaterThan(firstDeadline.getTime() + 100_000);

			await control.uploadIntent.update({
				where: { id },
				data: { claimUntil: FAR_PAST },
			});
			await expect(owner.renewClaim(id, ownerToken, 180_000))
				.resolves.toEqual({ count: 0 });
			await expect(owner.markReferenced(id, ownerToken))
				.rejects.toThrow('Upload intent claim was lost');
			await expect(owner.markMissing(id, ownerToken))
				.rejects.toThrow('Upload intent claim was lost');
			await expect(owner.queueCleanup(id, ownerToken, bucket, storageKey))
				.rejects.toThrow('Upload intent claim was lost');
			await expect(owner.markSweepFailed(
				id,
				ownerToken,
				new Error('stale worker'),
				FAR_FUTURE,
			)).rejects.toThrow('Upload intent claim was lost');
			await expect(control.uploadIntent.findUniqueOrThrow({ where: { id } }))
				.resolves.toMatchObject({
					state: 'PREPARED',
					claimToken: ownerToken,
					claimUntil: FAR_PAST,
					attemptCount: 0,
				});
			await expect(control.orphanObject.count({ where: { bucket, storageKey } }))
				.resolves.toBe(0);

			const head = vi.fn().mockResolvedValue(null);
			const pastClockWorker = createUploadIntentService({
				repository: contender,
				references: {
					collect: vi.fn().mockResolvedValue({ references: [], unsafeBuckets: new Set() }),
				},
				storage: { head },
				clock: { now: () => FAR_PAST },
				ids: { next: () => takeoverToken },
				logger: { info: vi.fn(), error: vi.fn() },
				graceMs: 0,
			});
			await expect(pastClockWorker.sweep()).resolves.toEqual({
				tried: 1,
				referenced: 0,
				queued: 0,
				missing: 1,
			});
			expect(head).toHaveBeenCalledWith(bucket, storageKey, expect.any(Object));
			await expect(control.uploadIntent.findUniqueOrThrow({ where: { id } }))
				.resolves.toMatchObject({ state: 'RESOLVED', claimToken: null, claimUntil: null });
		});

		it('allows only one upload-intent claimant on independent database connections', async () => {
			const id = randomUUID();
			await createUploadIntentRepository(control).prepare({
				id,
				bucket,
				storageKey: `${testId}/upload-intent-race.bin`,
				purpose: 'lease-clock-concurrency',
				notBefore: FAR_PAST,
			});
			const [first, second] = await Promise.all([
				createUploadIntentRepository(firstWorker).claimStale(1, 'intent-first', 60_000),
				createUploadIntentRepository(secondWorker).claimStale(1, 'intent-second', 60_000),
			]);
			expect([...first, ...second].filter((row) => row.id === id)).toHaveLength(1);
		});

		it('uses PostgreSQL time for multipart-abort takeover and fences stale resolve/failure', async () => {
			const target = {
				bucket,
				storageKey: `${testId}/multipart-abort.zip`,
				uploadId: `upload-${testId}`,
				reason: 'lease-clock-regression',
			};
			const ownerToken = randomUUID();
			const takeoverToken = randomUUID();
			const owner = createMultipartAbortRepository(firstWorker);
			const contender = createMultipartAbortRepository(secondWorker);
			const task = await owner.queue(target);
			await expect(owner.claim(1, ownerToken, 60_000)).resolves.toEqual([
				expect.objectContaining({ id: task.id }),
			]);
			const firstDeadline = (await control.multipartAbortTask.findUniqueOrThrow({
				where: { id: task.id },
			})).claimUntil!;
			await expectDatabaseLeaseDeadline(control, firstDeadline, 30_000, 90_000);

			const abortWhileActive = vi.fn();
			const futureClockWorker = createMultipartAbortService({
				repository: contender,
				storage: { abortMultipart: abortWhileActive },
				clock: { now: () => FAR_FUTURE },
				ids: { next: () => takeoverToken },
				logger: { error: vi.fn() },
			});
			await expect(futureClockWorker.run()).resolves.toEqual({
				tried: 0,
				resolved: 0,
				failed: 0,
			});
			expect(abortWhileActive).not.toHaveBeenCalled();

			await expect(contender.renew(task.id, 'wrong-token', 180_000))
				.resolves.toEqual({ count: 0 });
			await expect(owner.renew(task.id, ownerToken, 180_000))
				.resolves.toEqual({ count: 1 });
			const renewedDeadline = (await control.multipartAbortTask.findUniqueOrThrow({
				where: { id: task.id },
			})).claimUntil!;
			expect(renewedDeadline.getTime()).toBeGreaterThan(firstDeadline.getTime() + 100_000);

			await control.multipartAbortTask.update({
				where: { id: task.id },
				data: { claimUntil: FAR_PAST },
			});
			await expect(owner.renew(task.id, ownerToken, 180_000))
				.resolves.toEqual({ count: 0 });
			await expect(owner.resolve(task.id, ownerToken, FAR_FUTURE))
				.rejects.toThrow('Multipart abort task claim was lost');
			await expect(owner.fail(
				task.id,
				ownerToken,
				new Error('stale worker'),
				FAR_FUTURE,
			)).rejects.toThrow('Multipart abort task claim was lost');
			await expect(control.multipartAbortTask.findUniqueOrThrow({ where: { id: task.id } }))
				.resolves.toMatchObject({
					state: 'CLAIMED',
					claimToken: ownerToken,
					claimUntil: FAR_PAST,
					attemptCount: 0,
				});

			const abortAfterExpiry = vi.fn().mockResolvedValue(undefined);
			const pastClockWorker = createMultipartAbortService({
				repository: contender,
				storage: { abortMultipart: abortAfterExpiry },
				clock: { now: () => FAR_PAST },
				ids: { next: () => takeoverToken },
				logger: { error: vi.fn() },
			});
			await expect(pastClockWorker.run()).resolves.toEqual({
				tried: 1,
				resolved: 1,
				failed: 0,
			});
			expect(abortAfterExpiry).toHaveBeenCalledOnce();
			await expect(control.multipartAbortTask.findUniqueOrThrow({ where: { id: task.id } }))
				.resolves.toMatchObject({ state: 'RESOLVED', claimToken: null, claimUntil: null });
		});

		it('allows only one multipart-abort claimant on independent database connections', async () => {
			const repository = createMultipartAbortRepository(control);
			const task = await repository.queue({
				bucket,
				storageKey: `${testId}/multipart-abort-race.zip`,
				uploadId: `race-${testId}`,
				reason: 'lease-clock-concurrency',
			});
			const [first, second] = await Promise.all([
				createMultipartAbortRepository(firstWorker).claim(1, 'abort-first', 60_000),
				createMultipartAbortRepository(secondWorker).claim(1, 'abort-second', 60_000),
			]);
			expect([...first, ...second].filter((row) => row.id === task.id)).toHaveLength(1);
		});

		it('uses PostgreSQL time for idempotency takeover and fences stale completion/failure', async () => {
			const key = `idempotency-${testId}`;
			const firstToken = randomUUID();
			const firstId = randomUUID();
			const firstIds = [firstToken, firstId];
			const initial = createIdempotencyService({
				repository: createIdempotencyRepository(firstWorker),
				clock: { now: () => FAR_FUTURE },
				ids: { next: () => firstIds.shift()! },
			});
			const claim = await initial.claim({
				actorId,
				scope: 'lease-clock',
				key,
				requestHash: 'same-request',
			});
			if (claim.kind !== 'acquired') throw new Error('Expected initial idempotency claim');

			const activeConflictToken = randomUUID();
			const activeConflictId = randomUUID();
			const takeoverToken = randomUUID();
			const takeoverId = randomUUID();
			const secondIds = [
				activeConflictToken,
				activeConflictId,
				takeoverToken,
				takeoverId,
			];
			const contender = createIdempotencyService({
				repository: createIdempotencyRepository(secondWorker),
				clock: { now: () => FAR_PAST },
				ids: { next: () => secondIds.shift()! },
			});
			await expect(contender.claim({
				actorId,
				scope: 'lease-clock',
				key,
				requestHash: 'same-request',
			})).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS', statusCode: 409 });

			const owner = createIdempotencyRepository(firstWorker);
			await expect(owner.purgeExpired(new Date('9999-01-01T00:00:00.000Z')))
				.resolves.toEqual({ count: 0 });
			await expect(control.idempotencyOperation.findUnique({
				where: { id: claim.operationId },
			})).resolves.not.toBeNull();
			await expect(owner.renewOwnership({
				operationId: claim.operationId,
				ownerToken: 'wrong-token',
				leaseMs: 180_000,
			})).resolves.toEqual({ count: 0 });
			const firstDeadline = (await control.idempotencyOperation.findUniqueOrThrow({
				where: { id: claim.operationId },
			})).ownerUntil!;
			await expectDatabaseLeaseDeadline(control, firstDeadline, 60_000, 3 * 60_000);
			await expect(owner.renewOwnership({
				operationId: claim.operationId,
				ownerToken: claim.ownerToken,
				leaseMs: 180_000,
			})).resolves.toEqual({ count: 1 });
			const renewedDeadline = (await control.idempotencyOperation.findUniqueOrThrow({
				where: { id: claim.operationId },
			})).ownerUntil!;
			expect(renewedDeadline.getTime()).toBeGreaterThan(firstDeadline.getTime() + 40_000);

			await control.idempotencyOperation.update({
				where: { id: claim.operationId },
				data: { ownerUntil: FAR_PAST },
			});
			await expect(owner.renewOwnership({
				operationId: claim.operationId,
				ownerToken: claim.ownerToken,
				leaseMs: 180_000,
			})).resolves.toEqual({ count: 0 });
			await expect(firstWorker.$transaction((tx) => succeedIdempotencyOperation(tx, {
				operationId: claim.operationId,
				ownerToken: claim.ownerToken,
				result: { stale: true },
			}))).rejects.toThrow('Idempotency operation lease was lost before commit');
			await expect(owner.markFailed({
				operationId: claim.operationId,
				ownerToken: claim.ownerToken,
				terminal: true,
				error: new Error('stale failure'),
			})).rejects.toThrow('Idempotency operation lease was lost before failure update');

			const takeover = await contender.claim({
				actorId,
				scope: 'lease-clock',
				key,
				requestHash: 'same-request',
			});
			expect(takeover).toMatchObject({ kind: 'acquired', ownerToken: takeoverToken });
			await expect(control.idempotencyOperation.findUniqueOrThrow({
				where: { id: claim.operationId },
			})).resolves.toMatchObject({
				state: 'IN_PROGRESS',
				ownerToken: takeoverToken,
			});
		});

		it('allows only one idempotency owner on independent database connections', async () => {
			const input = {
				actorId,
				scope: 'lease-clock-concurrency',
				key: `idempotency-race-${testId}`,
				requestHash: 'same-request',
			};
			const service = (client: PrismaClient) => createIdempotencyService({
				repository: createIdempotencyRepository(client),
				clock: { now: () => FAR_FUTURE },
				ids: { next: () => randomUUID() },
			});
			const outcomes = await Promise.allSettled([
				service(firstWorker).claim(input),
				service(secondWorker).claim(input),
			]);
			expect(outcomes.filter((outcome) => (
				outcome.status === 'fulfilled' && outcome.value.kind === 'acquired'
			))).toHaveLength(1);
			expect(outcomes.filter((outcome) => (
				outcome.status === 'rejected'
				&& typeof outcome.reason === 'object'
				&& outcome.reason !== null
				&& 'code' in outcome.reason
				&& outcome.reason.code === 'OPERATION_IN_PROGRESS'
			))).toHaveLength(1);
		});
	},
);
