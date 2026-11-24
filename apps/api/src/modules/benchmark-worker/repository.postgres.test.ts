import { LAB_NICKNAME_SYSTEM_PROMPT } from '@pcu/contracts';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createIsolatedMigratedDatabase } from '../../__tests__/helpers/isolated-migrated-database.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { claimCase, finishCase, renewLease, type Claim } from './repository.js';
import type { Attempt } from './evaluate.js';
import { readLabConfig } from './config.js';
import { processNextCase } from './service.js';

describe.runIf(process.env.RUN_POSTGRES_INTEGRATION === 'true')(
	'benchmark lease ownership in PostgreSQL',
	() => {
		let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
		let db: PrismaClient;
		let ownerId: number;
		beforeAll(async () => {
			database = await createIsolatedMigratedDatabase(process.env.DATABASE_URL!);
			db = database.createClient();
			ownerId = (await db.user.create({ data: { googleSub: randomUUID(), role: 'BETA_TESTER' } })).id;
		});
		afterAll(async () => {
			await database?.close();
		});
		afterEach(() => vi.unstubAllGlobals());
		async function queued(count: number) {
			const dataset = await db.labDataset.create({
				data: { ownerId, name: 'test', hash: randomUUID(), count },
			});
			const cases = Array.from({ length: count }, (_, i) => ({
				caseId: 'en-' + (i + 1),
				datasetId: dataset.id,
				ordinal: i,
				nickname: '가상닉네임' + i,
				body: {
					id: 'en-' + (i + 1),
					nickname: '가상닉네임' + i,
					reference: { expectedReason: 'SECRET_REASON', expectedScore: 79 },
					tags: [],
				},
			}));
			await db.labTestCase.createMany({ data: cases });
			const run = await db.labRun.create({
				data: {
					ownerId,
					datasetId: dataset.id,
					datasetHash: dataset.hash,
					promptHash: 'hash',
					systemPrompt: LAB_NICKNAME_SYSTEM_PROMPT,
					provider: 'ollama',
					model: 'test',
					temperature: 0,
					maxTokens: 128,
					size: count,
					searchMode: 'no_search',
				},
			});
			await db.labResult.createMany({
				data: cases.map(({ caseId, datasetId, ordinal }) => ({ runId: run.id, caseId, datasetId, ordinal })),
			});
			return run.id;
		}
		async function next(limit = 1) {
			const claim = await claimCase(db, limit);
			if (!claim || claim === 'reaped') throw new Error('Expected a claim');
			return claim;
		}
		const failure: Attempt = {
			output: null,
			error: 'MODEL_INVALID_ENVELOPE',
			retryable: false,
			sources: [],
			searchCount: 0,
			toolSucceeded: false,
			toolSupport: 'unknown',
			toolCalls: 0,
			jsonAttempts: 1,
			outputFormat: 'schema',
			durationMs: 8,
		};
		async function expire(claim: Claim) {
			await db.labResult.update({
				where: { runId_caseId: { runId: claim.runId, caseId: claim.caseId } },
				data: { leaseUntil: new Date(0) },
			});
		}
		it('keeps a 4B case queued while the model tunnel is unavailable', async () => {
			const id = await queued(1);
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unavailable')));
			const config = readLabConfig({
				LAB_ENABLED: 'true',
				LAB_MODEL_PROVIDER: 'transformers-generate',
				LAB_MODEL: 'test-4b',
				LAB_MODEL_URL: 'http://model.test',
			});
			expect(await processNextCase(db, config)).toBe(false);
			expect(await db.labResult.findFirstOrThrow({ where: { runId: id } })).toMatchObject({
				status: 'PENDING', attempts: 0,
			});
			const claim = await next();
			expect(claim.item.testCase.context).toBe('context');
			await finishCase(db, claim, failure);
		});

		it('limits concurrent claims globally, fences old holders and completes concurrent results exactly once', async () => {
			const runId = await queued(2);
			const claims = await Promise.all([claimCase(db, 1), claimCase(db, 1), claimCase(db, 1)]);
			const old = claims.find((claim): claim is Claim => !!claim && claim !== 'reaped')!;
			expect(claims.filter(Boolean)).toHaveLength(1);
			expect(old.item.input).toEqual({ nickname: '가상닉네임0' });
			expect(JSON.stringify(old.item)).not.toMatch(/SECRET_REASON|expectedScore|reference|caseId|familyId/);
			expect(await renewLease(db, old)).toBe(true);
			await expire(old);
			expect(await renewLease(db, old)).toBe(false);
			const newer = await next();
			expect(newer.caseId).toBe(old.caseId);
			expect(newer.token).not.toBe(old.token);
			expect(await finishCase(db, old, failure)).toBe(false);
			const other = await next(2);
			expect(other.caseId).not.toBe(newer.caseId);
			expect(await Promise.all([finishCase(db, newer, failure), finishCase(db, other, failure)])).toEqual([
				true,
				true,
			]);
			const run = await db.labRun.findUniqueOrThrow({ where: { id: runId }, include: { results: true } });
			expect(run.status).toBe('COMPLETED');
			expect(run.startedAt).not.toBeNull();
			expect(run.completedAt).not.toBeNull();
			expect(run.results.map((row) => row.status)).toEqual(['FAILED', 'FAILED']);
			const recovered = run.results.find((row) => row.caseId === newer.caseId)!;
			expect(recovered.attempts).toBe(2);
			expect(recovered.history).toEqual(
				expect.arrayContaining([expect.objectContaining({ event: 'lease_expired', attempt: 1 })]),
			);
			expect(await finishCase(db, newer, failure)).toBe(false);
		});
		it('bounds crash-only recovery and leaves exhausted work terminal across polls', async () => {
			const id = await queued(1);
			for (let attempt = 1; attempt <= 3; attempt++) await expire(await next());
			expect(await claimCase(db, 1)).toBe('reaped');
			expect(await claimCase(db, 1)).toBeNull();
			const result = await db.labResult.findFirstOrThrow({ where: { runId: id } });
			expect(result).toMatchObject({
				status: 'FAILED',
				attempts: 3,
				error: 'ATTEMPT_LIMIT',
				leaseToken: null,
			});
			expect((await db.labRun.findUniqueOrThrow({ where: { id } })).status).toBe('COMPLETED');
		});
		it('preserves cancellation after a late model response', async () => {
			const id = await queued(1);
			const claim = await next();
			await db.$transaction(async (tx) => {
				await tx.labRun.update({ where: { id }, data: { status: 'CANCELLED', completedAt: new Date() } });
				await tx.labResult.updateMany({
					where: { runId: id },
					data: { status: 'CANCELLED', leaseToken: null, leaseUntil: null },
				});
			});
			expect(await finishCase(db, claim, failure)).toBe(false);
			expect(await renewLease(db, claim)).toBe(false);
			expect(await claimCase(db, 1)).toBeNull();
		});
		it('aborts an in-flight inference when its run is cancelled, even with a slow model', async () => {
			const id = await queued(1);
			const config = readLabConfig({
				LAB_ENABLED: 'true',
				LAB_MODEL: 'test',
				LAB_MODEL_URL: 'http://model.test',
			});
			let notifyStarted!: () => void;
			const started = new Promise<void>((resolve) => {
				notifyStarted = resolve;
			});
			let aborted = false;
			vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
				if (url.endsWith('/api/show'))
					return Promise.resolve(Response.json({ capabilities: ['completion'] }));
				notifyStarted();
				return new Promise<Response>((_resolve, reject) => {
					init.signal!.addEventListener(
						'abort',
						() => {
							aborted = true;
							reject(new Error('aborted'));
						},
						{ once: true },
					);
				});
			});
			const processing = processNextCase(db, config);
			await started;
			await db.$transaction(async (tx) => {
				await tx.labRun.update({ where: { id }, data: { status: 'CANCELLED', completedAt: new Date() } });
				await tx.labResult.updateMany({
					where: { runId: id },
					data: { status: 'CANCELLED', leaseToken: null, leaseUntil: null },
				});
			});
			expect(await processing).toBe(true);
			expect(aborted).toBe(true);
			expect(await db.labResult.findFirstOrThrow({ where: { runId: id } })).toMatchObject({
				status: 'CANCELLED',
				output: null,
			});
		});
		it('retries transient errors up to the per-request budget and preserves prior history', async () => {
			const runId = await queued(1);
			for (let i = 0; i < 3; i++) {
				const claim = await next();
				expect(await finishCase(db, claim, { ...failure, retryable: true })).toBe(true);
			}
			let result = await db.labResult.findFirstOrThrow({ where: { runId } });
			expect(result).toMatchObject({ attempts: 3, status: 'FAILED', retryBase: 0 });
			await db.$transaction(async (tx) => {
				await tx.labRun.update({ where: { id: runId }, data: { status: 'QUEUED', completedAt: null } });
				await tx.labResult.updateMany({ where: { runId }, data: { retryBase: 3, status: 'PENDING' } });
			});
			const claim = await next();
			expect(await finishCase(db, claim, failure)).toBe(true);
			result = await db.labResult.findFirstOrThrow({ where: { runId } });
			expect(result).toMatchObject({ attempts: 4, status: 'FAILED', retryBase: 3 });
			expect(result.history).toHaveLength(8);
		});
	},
);
