import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	cleanupStaleGameWorkspaces,
	GAME_WORKSPACE_PREFIX,
	materializeAndValidateGameSource,
} from '../modules/admin/game-upload/validation-worker.game-processor.js';
import {
	SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
	sourceIdentityRoot,
} from '../modules/admin/game-upload/source-identity.js';
import { createWebglProcessingRepository } from '../modules/asset-upload/webgl-processing-repository.js';
import { ImageInfrastructureError, ImageRejectedError } from '../modules/image/errors.js';
import { materializeImageSource } from '../modules/image/materialize.js';
import { createImageWorker } from '../modules/image/worker.js';
import type { VerifyingImageSession } from '../modules/image/ports.js';
import {
	WorkerSourceObjectMissingError,
	MAX_WORKER_VALIDATION_ATTEMPTS,
} from '../modules/upload-lifecycle/worker-errors.js';
import { cleanupStaleWorkerDirectories } from '../modules/upload-lifecycle/worker-workspace.js';
import { cleanupStaleVideoWorkspaces } from '../modules/video/materialize.js';
import { createWebglProcessingWorker } from '../modules/webgl/processing-worker.js';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function imageSession(overrides: Partial<VerifyingImageSession> = {}): VerifyingImageSession {
	return {
		id: 'session-image', kind: 'IMAGE', state: 'VERIFYING',
		owner: { type: 'PROJECT', id: '7' }, actorId: '9',
		originalName: 'image.png', declaredMimeType: 'image/png', totalBytes: 10n,
		bucket: 'protected', objectKey: 'protected/uploads/session-image/1/source', generation: 1,
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'identity',
		sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: 'manifest',
		validationAttemptCount: 1, expectedTargetAssetId: null,
		...overrides,
	};
}

function sourceProof(bytes: Buffer) {
	const digest = createHash('sha256').update(bytes).digest();
	return {
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
		sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		sourceIdentityBlockManifest: digest.toString('base64'),
		sourceIdentity: sourceIdentityRoot(
			bytes.length, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, [digest.toString('hex')],
		),
	};
}

function repository(session = imageSession()) {
	return {
		claimVerifying: vi.fn(async () => [session]),
		renewLease: vi.fn(async () => true),
		prepareOutputPlan: vi.fn(), markOutputUploaded: vi.fn(), commitReady: vi.fn(),
		reject: vi.fn(async () => true),
	};
}

function worker(repo: ReturnType<typeof repository>, process: (...args: never[]) => Promise<unknown>) {
	return createImageWorker({
		repository: repo as never,
		processor: { process: process as never } as never,
		ids: { next: () => 'claim-token' },
		logger: { error: vi.fn(), warn: vi.fn() },
	});
}

describe('canonical processing fences', () => {
	it('performs zero stale writes after a lease takeover is observed', async () => {
		const repo = repository();
		repo.renewLease.mockResolvedValueOnce(false);
		let staleWrites = 0;
		const process = vi.fn(async (_session, _token, _signal, assertOwned: () => Promise<void>) => {
			await assertOwned();
			staleWrites += 1;
		});
		await expect(worker(repo, process as never).runPass()).resolves.toMatchObject({ retried: 1 });
		expect(staleWrites).toBe(0);
		expect(repo.reject).not.toHaveBeenCalled();
	});

	it('terminalizes an authoritative source 404 but retries an outage', async () => {
		const missingRepo = repository();
		const missing = worker(missingRepo, vi.fn(async () => {
			throw new WorkerSourceObjectMissingError('source does not exist');
		}) as never);
		await expect(missing.runPass()).resolves.toMatchObject({ rejected: 1, retried: 0 });
		expect(missingRepo.reject).toHaveBeenCalledWith(expect.objectContaining({
			reason: expect.stringContaining('does not exist'),
		}));

		const outageRepo = repository();
		const outage = worker(outageRepo, vi.fn(async () => { throw new Error('Garage 503'); }) as never);
		await expect(outage.runPass()).resolves.toMatchObject({ rejected: 0, retried: 1 });
		expect(outageRepo.reject).not.toHaveBeenCalled();
	});

	it('dead-letters a transient failure at the bounded attempt budget with an operator reason', async () => {
		const repo = repository(imageSession({ validationAttemptCount: MAX_WORKER_VALIDATION_ATTEMPTS }));
		const subject = worker(repo, vi.fn(async () => { throw new Error('Garage 503'); }) as never);
		await expect(subject.runPass()).resolves.toMatchObject({ rejected: 1, retried: 0 });
		expect(repo.reject).toHaveBeenCalledWith(expect.objectContaining({
			reason: expect.stringMatching(/^OPERATOR_REQUIRED:/),
		}));
	});
});

describe('worker workspace recovery', () => {
	it('removes only stale closed-grammar directories and protects symlinks and foreign entries', async () => {
		const root = await mkdtemp(join(tmpdir(), 'worker-scavenger-test-'));
		roots.push(root);
		const stale = join(root, 'pcu-image-worker-ABC123');
		const fresh = join(root, 'pcu-image-worker-DEF456');
		const foreign = join(root, 'pcu-image-worker-foreign-name');
		const outside = join(root, 'outside');
		const link = join(root, 'pcu-image-worker-LINK12');
		await Promise.all([mkdir(stale), mkdir(fresh), mkdir(foreign), mkdir(outside)]);
		await symlink(outside, link, 'dir');
		const old = new Date('2026-01-01T00:00:00Z');
		await Promise.all([utimes(stale, old, old), utimes(foreign, old, old)]);

		await expect(cleanupStaleWorkerDirectories({
			tempRoot: root, prefix: 'pcu-image-worker-', cutoff: new Date('2026-08-21T00:00:00Z'),
		})).resolves.toBe(1);
		await expect(readFile(link)).rejects.toBeDefined();
		await expect(mkdir(stale)).resolves.toBeUndefined();
		await expect(mkdir(fresh)).rejects.toMatchObject({ code: 'EEXIST' });
		await expect(mkdir(foreign)).rejects.toMatchObject({ code: 'EEXIST' });
		await expect(mkdir(outside)).rejects.toMatchObject({ code: 'EEXIST' });
		const linkedRoot = join(root, 'linked-root');
		await symlink(root, linkedRoot, 'dir');
		await expect(cleanupStaleWorkerDirectories({
			tempRoot: linkedRoot, prefix: 'pcu-image-worker-', cutoff: new Date('2026-08-21T00:00:00Z'),
		})).rejects.toThrow('must be a real directory');
	});

	it('gives every GAME retry a fresh workspace and scavenges a crash residue later', async () => {
		const root = await mkdtemp(join(tmpdir(), 'game-worker-retry-test-'));
		roots.push(root);
		const residue = join(root, `${GAME_WORKSPACE_PREFIX}ABC123`);
		await mkdir(residue);
		const old = new Date('2026-01-01T00:00:00Z');
		await utimes(residue, old, old);
		const bytes = Buffer.from('not a zip');
		const proof = sourceProof(bytes);

		await expect(materializeAndValidateGameSource({
			session: {
				id: 'same-session-after-crash', totalBytes: BigInt(bytes.length),
				...proof,
				sourceIdentityBlockManifest: Buffer.from(proof.sourceIdentityBlockManifest, 'base64'),
			},
			source: Readable.from([bytes]), tempRoot: root, physicalByteLimit: 1024,
		})).rejects.not.toMatchObject({ code: 'EEXIST' });
		expect(await readdir(root)).toEqual([`${GAME_WORKSPACE_PREFIX}ABC123`]);
		await expect(cleanupStaleGameWorkspaces(root, new Date('2026-08-21T00:00:00Z')))
			.resolves.toBe(1);
		expect(await readdir(root)).toEqual([]);
	});

	it('uses the common closed grammar for VIDEO residues and protects prefix lookalikes', async () => {
		const root = await mkdtemp(join(tmpdir(), 'video-worker-scavenger-test-'));
		roots.push(root);
		const stale = join(root, 'pcu-video-worker-ABC123');
		const lookalike = join(root, 'pcu-video-worker-ABC123-extra');
		const outside = join(root, 'outside');
		const link = join(root, 'pcu-video-worker-LINK12');
		await Promise.all([mkdir(stale), mkdir(lookalike), mkdir(outside)]);
		await symlink(outside, link, 'dir');
		const old = new Date('2026-01-01T00:00:00Z');
		await Promise.all([utimes(stale, old, old), utimes(lookalike, old, old)]);

		await expect(cleanupStaleVideoWorkspaces(root, new Date('2026-08-21T00:00:00Z')))
			.resolves.toBe(1);
		expect(await readdir(root)).toEqual(expect.arrayContaining([
			'outside', 'pcu-video-worker-ABC123-extra', 'pcu-video-worker-LINK12',
		]));
	});
});

describe('image source materialization classification', () => {
	it.each(['ECONNRESET', 'EIO'])('preserves a mid-stream %s as a transient infrastructure error', async (code) => {
		const root = await mkdtemp(join(tmpdir(), 'image-materialize-test-'));
		roots.push(root);
		const bytes = Buffer.from('\u0089PNG\r\n\u001a\nsource-body', 'binary');
		const proof = sourceProof(bytes);
		const body = Readable.from((async function* () {
			yield bytes.subarray(0, 4);
			throw Object.assign(new Error(`${code} during Garage GET`), { code });
		})());

		await expect(materializeImageSource({
			session: imageSession({ totalBytes: BigInt(bytes.length), ...proof }),
			body, tempRoot: root, maxBytes: 1024,
		})).rejects.toBeInstanceOf(ImageInfrastructureError);
		expect(await readdir(root)).toEqual([]);
	});

	it('terminalizes a genuine source identity mismatch', async () => {
		const root = await mkdtemp(join(tmpdir(), 'image-materialize-test-'));
		roots.push(root);
		const expected = Buffer.from('\u0089PNG\r\n\u001a\nexpected', 'binary');
		const actual = Buffer.from('\u0089PNG\r\n\u001a\nmodified', 'binary');
		const proof = sourceProof(expected);
		await expect(materializeImageSource({
			session: imageSession({ totalBytes: BigInt(expected.length), ...proof }),
			body: Readable.from([actual]), tempRoot: root, maxBytes: 1024,
		})).rejects.toMatchObject({
			name: ImageRejectedError.name,
			code: 'SOURCE_IDENTITY_INVALID',
		});
		expect(await readdir(root)).toEqual([]);
	});
});

describe('WebGL dead-letter candidate cleanup', () => {
	it('uses the bounded retry budget and records an operator dead letter', async () => {
		const rejectInvalidSource = vi.fn(async () => undefined);
		const session = {
			id: 'webgl-session', projectId: 7, kind: 'WEBGL', state: 'VERIFYING', generation: 1,
			validationAttemptCount: MAX_WORKER_VALIDATION_ATTEMPTS,
		};
		const subject = createWebglProcessingWorker({
			repository: {
				claimVerifyingWebglSessions: vi.fn(async () => [session as never]),
				assertValidationLease: vi.fn(), renewValidationLease: vi.fn(async () => true),
				releaseValidationLease: vi.fn(), rejectInvalidSource,
			},
			processor: { process: vi.fn(async () => { throw new Error('Garage 503'); }) },
			ids: { next: () => 'claim' }, clock: { now: () => new Date('2026-08-21T00:00:00Z') },
			options: { concurrency: 1, leaseMs: 60_000, heartbeatMs: 10_000 },
			logger: { error: vi.fn() },
		});
		await expect(subject.runPass()).resolves.toMatchObject({ rejected: 1, retried: 0 });
		expect(rejectInvalidSource).toHaveBeenCalledWith(expect.objectContaining({
			error: expect.stringMatching(/^OPERATOR_REQUIRED:/),
		}));
	});

	it('queues only the exact non-READY reserved prefix and preserves immutable READY history', async () => {
		function harness(state: 'PROCESSING' | 'READY') {
			const orphanUpsert = vi.fn(async () => ({}));
			const deploymentUpdate = vi.fn(async () => ({}));
			const tx = {
				assetUploadSession: {
					findUnique: vi.fn(async () => ({
						id: 'webgl-session', kind: 'WEBGL', generation: 1, state: 'VERIFYING',
						validationLeaseToken: 'claim', resultRepresentationId: null, resultAssetId: null,
						bucket: 'protected', objectKey: 'protected/uploads/webgl-session/1/source.zip',
						reservedWebglDeploymentId: 'candidate',
						reservedWebglDeployment: {
							id: 'candidate', state, publicBucket: 'public',
							publicPrefix: 'public/webgl/7/candidate/',
						},
					})),
					update: vi.fn(async () => ({})),
				},
				assetRepresentation: { update: vi.fn() }, asset: { update: vi.fn() },
				webglDeployment: { update: deploymentUpdate },
				orphanObject: { upsert: orphanUpsert },
				$queryRaw: vi.fn(async () => [{ id: 'owned' }]),
			};
			return {
				tx, orphanUpsert, deploymentUpdate,
				repository: createWebglProcessingRepository({
					$transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
				} as never),
			};
		}

		const candidate = harness('PROCESSING');
		await candidate.repository.rejectInvalidSource({
			sessionId: 'webgl-session', generation: 1, claimToken: 'claim',
			error: 'OPERATOR_REQUIRED: Garage remained unavailable',
		});
		expect(candidate.deploymentUpdate).toHaveBeenCalledWith(expect.objectContaining({
			where: { id: 'candidate' }, data: expect.objectContaining({ state: 'FAILED' }),
		}));
		expect(candidate.orphanUpsert).toHaveBeenCalledOnce();
		expect(candidate.orphanUpsert).toHaveBeenCalledWith(expect.objectContaining({
			create: expect.objectContaining({
				bucket: 'public', storageKey: 'public/webgl/7/candidate/',
				targetKind: 'PREFIX', reason: 'webgl-processing-dead-letter-candidate',
			}),
		}));

		const immutable = harness('READY');
		await immutable.repository.rejectInvalidSource({
			sessionId: 'webgl-session', generation: 1, claimToken: 'claim',
			error: 'OPERATOR_REQUIRED: stale retry',
		});
		expect(immutable.deploymentUpdate).not.toHaveBeenCalled();
		expect(immutable.orphanUpsert).not.toHaveBeenCalled();
	});
});

describe('immutable WebGL history and production image identity', () => {
	it('preserves superseded READY deployment bytes and limits cleanup to fenced candidates', async () => {
		const source = await readFile(new URL('../modules/asset-upload/webgl-processing-repository.ts', import.meta.url), 'utf8');
		expect(source).toContain('READY deployments are immutable history');
		expect(source).not.toContain("reason: 'webgl-public-generation-superseded'");
		expect(source).toContain("reason: input.reason");
	});

	it('uses owner-row locking plus expected-pointer CAS for project and exhibition posters', async () => {
		const source = await readFile(new URL('../modules/image/prisma.repository.ts', import.meta.url), 'utf8');
		expect(source).toMatch(/FROM "projects" WHERE "id" = \$\{ownerId\} FOR UPDATE/);
		expect(source).toMatch(/FROM "exhibitions" WHERE "id" = \$\{ownerId\} FOR UPDATE/);
		expect(source.match(/posterAssetId: session\.expectedTargetAssetId/g)).toHaveLength(2);
		expect(source).toContain("throw new WorkerGenerationFencedError('POSTER')");
	});

	it('terminalizes a GAME replacement fence under the unexpired DB-clock lease', async () => {
		const repository = await readFile(new URL('../modules/asset-upload/repository.ts', import.meta.url), 'utf8');
		const workerSource = await readFile(new URL('../modules/asset-upload/validation-worker.service.ts', import.meta.url), 'utf8');
		expect(repository).toContain("throw new WorkerGenerationFencedError('GAME')");
		expect(repository).toMatch(/AND "validation_lease_until" > clock_timestamp\(\)[\s\S]*RETURNING "id"/);
		expect(workerSource).toContain('error instanceof WorkerGenerationFencedError');
		expect(workerSource).toContain('markRejected(session.id, session.generation, token, reason)');
	});

	it('persists SHA-256 on PUT and reads authoritative checksum/ETag on HEAD', async () => {
		const workerSource = await readFile(new URL('../image-worker.ts', import.meta.url), 'utf8');
		const storageSource = await readFile(new URL('../lib/storage.ts', import.meta.url), 'utf8');
		expect(workerSource).toContain('checksumSha256: input.checksumSha256');
		expect(workerSource).toContain('object.etag');
		expect(storageSource).toContain("ChecksumMode: 'ENABLED'");
		expect(storageSource).toContain("Buffer.from(uploadOptions.checksumSha256, 'hex').toString('base64')");
	});
});
