import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createGameUploadRepository } from '../modules/admin/game-upload/repository.js';
import { signPartUrls } from '../modules/admin/game-upload/sign-part-urls.service.js';
import { sourceIdentityRoot } from '../modules/admin/game-upload/source-identity.js';
import type {
	DirectUploadQuotaLimits,
	NewGameUploadSession,
} from '../modules/admin/game-upload/ports.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const protectedBucket = 'pcu-protected';
const identityBlockSize = 1_048_576;
const identityDigest = createHash('sha256').update(Buffer.from([0])).digest('hex');
const quota: DirectUploadQuotaLimits = {
	actorActiveSessions: 4,
	projectActiveSessions: 2,
	actorOutstandingBytes: 10n * 1024n * 1024n * 1024n,
};

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

type Settled<T> =
	| { ok: true; value: T }
	| { ok: false; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
	return promise.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);
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

interface Fixture {
	suffix: string;
	userId: number;
	exhibitionId: number;
	projectId: number;
}

describe.runIf(runPostgresIntegration)('direct upload control-plane lock ordering', () => {
	let observer: PrismaClient;
	const clients: PrismaClient[] = [];

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required');
		observer = createPrismaClientForDatabase(namedDatabaseUrl(databaseUrl, 'control-race-observer'));
		await observer.$connect();
	});

	afterAll(async () => {
		await Promise.allSettled(clients.map((client) => client.$disconnect()));
		await observer?.$disconnect();
	});

	async function client(name: string): Promise<PrismaClient> {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required');
		const next = createPrismaClientForDatabase(namedDatabaseUrl(databaseUrl, name));
		clients.push(next);
		await next.$connect();
		return next;
	}

	async function fixture(): Promise<Fixture> {
		const suffix = randomUUID();
		const user = await observer.user.create({
			data: {
				googleSub: `control-race-${suffix}`,
				email: `control-race-${suffix}@example.test`,
				name: 'Control race actor',
				role: 'USER',
			},
		});
		const exhibition = await observer.exhibition.create({
			data: {
				year: 1_000_000_000 + Number.parseInt(suffix.slice(0, 6), 16),
				title: suffix,
				isUploadEnabled: true,
			},
		});
		const project = await observer.project.create({
			data: {
				exhibitionId: exhibition.id,
				creatorId: user.id,
				slug: `control-race-${suffix}`,
				title: 'Control-plane race',
				status: 'PUBLISHED',
			},
		});
		return { suffix, userId: user.id, exhibitionId: exhibition.id, projectId: project.id };
	}

	function sessionData(
		value: Fixture,
		id: string,
		key: string,
		uploadId: string,
	): NewGameUploadSession {
		return {
			id,
			projectId: value.projectId,
			userId: value.userId,
			uploadKind: 'GAME',
			originalName: 'game.zip',
			totalBytes: 1n,
			chunkSizeBytes: identityBlockSize,
			totalChunks: 1,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
			sourceIdentity: sourceIdentityRoot(1, identityBlockSize, [identityDigest]),
			sourceIdentityBlockSizeBytes: identityBlockSize,
			sourceIdentityBlockManifest: Buffer.from(identityDigest, 'hex'),
			s3UploadId: uploadId,
			s3Key: key,
			expiresAt: new Date('2099-01-01T00:00:00.000Z'),
		};
	}

	async function insertActive(value: Fixture, data: NewGameUploadSession): Promise<void> {
		await observer.gameUploadSession.create({
			data: {
				...data,
				sourceIdentityBlockManifest: Buffer.from(data.sourceIdentityBlockManifest),
			},
		});
		await observer.gameUploadActiveSession.create({
			data: { projectId: value.projectId, uploadKind: 'GAME', sessionId: data.id },
		});
	}

	async function cleanup(value: Fixture): Promise<void> {
		await observer.gameUploadActiveSession.deleteMany({ where: { projectId: value.projectId } });
		await observer.multipartAbortTask.deleteMany({
			where: { storageKey: { startsWith: `control-race/${value.suffix}/` } },
		});
		await observer.gameUploadSession.deleteMany({ where: { projectId: value.projectId } });
		await observer.project.deleteMany({ where: { id: value.projectId } });
		await observer.exhibition.deleteMany({ where: { id: value.exhibitionId } });
		await observer.user.deleteMany({ where: { id: value.userId } });
	}

	async function blockRow(
		blocker: PrismaClient,
		table: 'projects' | 'game_upload_sessions',
		id: number | string,
	) {
		const acquired = deferred();
		const release = deferred();
		const transaction = blocker.$transaction(async (tx) => {
			await tx.$queryRaw(Prisma.sql`
				SELECT "id" FROM ${Prisma.raw(`"${table}"`)}
				WHERE "id" = ${id}
				FOR UPDATE
			`);
			acquired.resolve();
			await release.promise;
		}, { timeout: 20_000 });
		await acquired.promise;
		return { release: release.resolve, transaction };
	}

	async function runCancelCompletionRace(first: 'cancel' | 'complete'): Promise<void> {
		const value = await fixture();
		const sessionId = randomUUID();
		const key = `control-race/${value.suffix}/cancel-complete.zip`;
		const uploadId = `upload-${value.suffix}`;
		await insertActive(value, sessionData(value, sessionId, key, uploadId));
		const blockerName = `control-cancel-blocker-${value.suffix}`;
		const cancelName = `control-cancel-${value.suffix}`;
		const completeName = `control-complete-${value.suffix}`;
		const blockerClient = await client(blockerName);
		const cancelRepository = createGameUploadRepository(await client(cancelName), {
			abortBucket: protectedBucket,
		});
		const completeRepository = createGameUploadRepository(await client(completeName), {
			abortBucket: protectedBucket,
		});
		const blocked = await blockRow(blockerClient, 'game_upload_sessions', sessionId);
		let cancelResult!: Promise<Awaited<ReturnType<typeof cancelRepository.cancelSessionAndClearActive>>>;
		let completionResult!: Promise<Awaited<ReturnType<typeof completeRepository.claimCompletion>>>;
		try {
			const startCancel = () => cancelRepository.cancelSessionAndClearActive(sessionId);
			const startComplete = () => completeRepository.claimCompletion({
				sessionId,
				generation: 1,
				token: `claim-${value.suffix}`,
				leaseMs: 120_000,
			});
			if (first === 'cancel') {
				cancelResult = startCancel();
				await waitForDatabaseLock(observer, cancelName);
				completionResult = startComplete();
				await waitForDatabaseLock(observer, completeName);
			} else {
				completionResult = startComplete();
				await waitForDatabaseLock(observer, completeName);
				cancelResult = startCancel();
				await waitForDatabaseLock(observer, cancelName);
			}
			blocked.release();
			await blocked.transaction;
			const [cancelled, completed] = await Promise.all([cancelResult, completionResult]);
			const session = await observer.gameUploadSession.findUniqueOrThrow({ where: { id: sessionId } });
			if (first === 'cancel') {
				expect(cancelled.count).toBe(1);
				expect(completed.count).toBe(0);
				expect(session).toMatchObject({ status: 'CANCELLED', s3Key: null, s3UploadId: null });
				await expect(observer.multipartAbortTask.findUniqueOrThrow({
					where: { multipart_abort_bucket_key_upload: {
						bucket: protectedBucket, storageKey: key, uploadId,
					} },
				})).resolves.toMatchObject({ reason: 'upload-session-cancelled' });
				await expect(observer.gameUploadActiveSession.findUnique({
					where: { projectId_uploadKind: { projectId: value.projectId, uploadKind: 'GAME' } },
				})).resolves.toBeNull();
			} else {
				expect(completed).toMatchObject({ count: 1, reason: null });
				expect(cancelled.count).toBe(0);
				expect(session).toMatchObject({ status: 'COMPLETING', s3Key: key, s3UploadId: uploadId });
				await expect(observer.multipartAbortTask.count({ where: { storageKey: key } })).resolves.toBe(0);
				await expect(observer.gameUploadActiveSession.findUnique({
					where: { projectId_uploadKind: { projectId: value.projectId, uploadKind: 'GAME' } },
				})).resolves.toMatchObject({ sessionId });
			}
		} finally {
			blocked.release();
			await blocked.transaction.catch(() => undefined);
			await cleanup(value);
		}
	}

	it.each(['cancel', 'complete'] as const)(
		'orders cancel and completion claims when %s reaches the session row first',
		async (first) => runCancelCompletionRace(first),
		30_000,
	);

	async function runReplacementCapabilityRace(first: 'capability' | 'replacement'): Promise<void> {
		const value = await fixture();
		const oldId = randomUUID();
		const oldKey = `control-race/${value.suffix}/old.zip`;
		const oldUploadId = `old-upload-${value.suffix}`;
		await insertActive(value, sessionData(value, oldId, oldKey, oldUploadId));
		const blockerClient = await client(`control-part-blocker-${value.suffix}`);
		const capabilityName = `control-part-${value.suffix}`;
		const replacementName = `control-replace-${value.suffix}`;
		const capabilityRepository = createGameUploadRepository(await client(capabilityName), {
			abortBucket: protectedBucket,
		});
		const replacementRepository = createGameUploadRepository(await client(replacementName), {
			abortBucket: protectedBucket,
		});
		const newId = randomUUID();
		const newKey = `control-race/${value.suffix}/replacement.zip`;
		const newUploadId = `replacement-upload-${value.suffix}`;
		const signer = vi.fn(async () => 'https://upload.example.test/part');
		const issue = () => signPartUrls({
			repository: capabilityRepository,
			partSigner: { presignUploadPart: signer },
			clock: { now: () => new Date('2026-08-20T00:00:00.000Z') },
			config: {
				uploadPartUrlBatchMax: 16,
				uploadPartUrlTtlSeconds: 300,
				uploadPartUrlRefreshMax: 64,
				uploadPartUrlRefreshWindowMs: 300_000,
				directUploadQuota: quota,
			},
			logger: { info: vi.fn() },
		}, oldId, { id: value.userId, role: 'USER' }, { generation: 1, parts: [{
			partNumber: 1,
			checksumSha256: createHash('sha256').update('part').digest('base64'),
		}] });
		const replace = () => replacementRepository.createSessionReplacingActive(
			sessionData(value, newId, newKey, newUploadId), quota,
		);
		const blocked = await blockRow(blockerClient, 'projects', value.projectId);
		let capabilityResult!: Promise<Settled<Awaited<ReturnType<typeof signPartUrls>>>>;
		let replacementResult!: Promise<Awaited<ReturnType<typeof replace>>>;
		try {
			if (first === 'capability') {
				capabilityResult = settle(issue());
				await waitForDatabaseLock(observer, capabilityName);
				replacementResult = replace();
				await waitForDatabaseLock(observer, replacementName);
			} else {
				replacementResult = replace();
				await waitForDatabaseLock(observer, replacementName);
				capabilityResult = settle(issue());
				await waitForDatabaseLock(observer, capabilityName);
			}
			blocked.release();
			await blocked.transaction;
			const [capability, replacement] = await Promise.all([capabilityResult, replacementResult]);
			expect(replacement.session.id).toBe(newId);
			if (first === 'capability') {
				expect(capability.ok).toBe(true);
				expect(signer).toHaveBeenCalledOnce();
			} else {
				expect(capability.ok).toBe(false);
				expect(signer).not.toHaveBeenCalled();
			}
			await expect(settle(issue())).resolves.toMatchObject({ ok: false });
			await expect(observer.gameUploadSession.findUniqueOrThrow({ where: { id: oldId } }))
				.resolves.toMatchObject({ status: 'CANCELLED', s3Key: null, s3UploadId: null });
			await expect(observer.gameUploadActiveSession.findUniqueOrThrow({
				where: { projectId_uploadKind: { projectId: value.projectId, uploadKind: 'GAME' } },
			})).resolves.toMatchObject({ sessionId: newId });
			await expect(observer.multipartAbortTask.findUniqueOrThrow({
				where: { multipart_abort_bucket_key_upload: {
					bucket: protectedBucket, storageKey: oldKey, uploadId: oldUploadId,
				} },
			})).resolves.toMatchObject({ reason: 'active-upload-replaced' });
		} finally {
			blocked.release();
			await blocked.transaction.catch(() => undefined);
			await cleanup(value);
		}
	}

	it.each(['capability', 'replacement'] as const)(
		'orders replacement and part capability issuance when %s reaches the project lock first',
		async (first) => runReplacementCapabilityRace(first),
		30_000,
	);

	it('serializes two session creates to one active generation and durably aborts the loser', async () => {
		const value = await fixture();
		const blockerClient = await client(`control-create-blocker-${value.suffix}`);
		const firstName = `control-create-first-${value.suffix}`;
		const secondName = `control-create-second-${value.suffix}`;
		const firstRepository = createGameUploadRepository(await client(firstName), {
			abortBucket: protectedBucket,
		});
		const secondRepository = createGameUploadRepository(await client(secondName), {
			abortBucket: protectedBucket,
		});
		const firstId = randomUUID();
		const secondId = randomUUID();
		const firstKey = `control-race/${value.suffix}/first.zip`;
		const secondKey = `control-race/${value.suffix}/second.zip`;
		const firstUploadId = `first-upload-${value.suffix}`;
		const secondUploadId = `second-upload-${value.suffix}`;
		const blocked = await blockRow(blockerClient, 'projects', value.projectId);
		let firstCreate!: Promise<Awaited<ReturnType<typeof firstRepository.createSessionReplacingActive>>>;
		let secondCreate!: Promise<Awaited<ReturnType<typeof secondRepository.createSessionReplacingActive>>>;
		try {
			firstCreate = firstRepository.createSessionReplacingActive(
				sessionData(value, firstId, firstKey, firstUploadId), quota,
			);
			await waitForDatabaseLock(observer, firstName);
			secondCreate = secondRepository.createSessionReplacingActive(
				sessionData(value, secondId, secondKey, secondUploadId), quota,
			);
			await waitForDatabaseLock(observer, secondName);
			blocked.release();
			await blocked.transaction;
			const [first, second] = await Promise.all([firstCreate, secondCreate]);
			expect(first.session.id).toBe(firstId);
			expect(second.session.id).toBe(secondId);
			expect(first.durableAborts).toEqual([]);
			expect(second.durableAborts).toEqual([expect.objectContaining({
				sessionId: firstId,
				key: firstKey,
				uploadId: firstUploadId,
				reason: 'active-upload-replaced',
			})]);
			await expect(observer.gameUploadActiveSession.findMany({
				where: { projectId: value.projectId, uploadKind: 'GAME' },
			})).resolves.toEqual([expect.objectContaining({ sessionId: secondId })]);
			await expect(observer.gameUploadSession.findUniqueOrThrow({ where: { id: firstId } }))
				.resolves.toMatchObject({ status: 'CANCELLED', s3Key: null, s3UploadId: null });
			await expect(observer.gameUploadSession.findUniqueOrThrow({ where: { id: secondId } }))
				.resolves.toMatchObject({ status: 'PENDING', s3Key: secondKey, s3UploadId: secondUploadId });
			await expect(observer.multipartAbortTask.findMany({
				where: { storageKey: { startsWith: `control-race/${value.suffix}/` } },
			})).resolves.toEqual([expect.objectContaining({
				bucket: protectedBucket,
				storageKey: firstKey,
				uploadId: firstUploadId,
			})]);
		} finally {
			blocked.release();
			await blocked.transaction.catch(() => undefined);
			await cleanup(value);
		}
	}, 30_000);
});
