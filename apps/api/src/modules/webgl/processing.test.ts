import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { brotliCompressSync, deflateRawSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	encodePersistedSourceIdentityManifest,
	SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
	sourceIdentityRoot,
} from '../admin/game-upload/source-identity.js';
import { createAssetUploadService } from '../asset-upload/service.js';
import type { AssetUploadRepository } from '../asset-upload/ports.js';
import { createWebglTempDiskBudget } from './processing.composition.js';
import {
	createWebglProcessingProcessor,
	WebglGenerationFencedError,
	WebglTerminalValidationError,
	type CanonicalWebglUploadSession,
	type ReservedWebglDeployment,
	type WebglProcessingRepository,
} from './processing.js';
import { createWebglProcessingWorker } from './processing-worker.js';
import { WorkerSourceObjectMissingError } from '../upload-lifecycle/worker-errors.js';

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < table.length; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(bytes: Buffer): number {
	let value = 0xffffffff;
	for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

function storedZip(entries: Array<{ name: string; body: string | Buffer; deflate?: boolean }>): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const spec of entries) {
		const name = Buffer.from(spec.name);
		const body = Buffer.from(spec.body);
		const compressed = spec.deflate ? deflateRawSync(body) : body;
		const method = spec.deflate ? 8 : 0;
		const checksum = crc32(body);
		const local = Buffer.alloc(30 + name.length + compressed.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(body.length, 22);
		local.writeUInt16LE(name.length, 26);
		name.copy(local, 30);
		compressed.copy(local, 30 + name.length);
		locals.push(local);

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(body.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);
		centrals.push(central);
		offset += local.length;
	}
	const directory = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(directory.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, eocd]);
}

function unityZip(): Buffer {
	return storedZip([
		{ name: 'index.html', body: '<html>Unity</html>' },
		{ name: 'Build/game.loader.js', body: 'loader' },
		{ name: 'Build/game.framework.js', body: 'framework' },
		{ name: 'Build/game.wasm.br', body: 'wasm' },
		{ name: 'Build/game.data.gz', body: 'data' },
	]);
}

function identity(bytes: Buffer) {
	const digests: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += SOURCE_IDENTITY_BLOCK_SIZE_BYTES) {
		digests.push(createHash('sha256')
			.update(bytes.subarray(offset, offset + SOURCE_IDENTITY_BLOCK_SIZE_BYTES)).digest('hex'));
	}
	return {
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' as const,
		sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		sourceIdentityBlockManifest: encodePersistedSourceIdentityManifest(
			Buffer.concat(digests.map((digest) => Buffer.from(digest, 'hex'))),
		),
		sourceIdentity: sourceIdentityRoot(bytes.length, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, digests),
		sourceIdentityBlockDigests: digests,
	};
}

function session(bytes: Buffer): CanonicalWebglUploadSession {
	const proof = identity(bytes);
	return {
		id: randomUUID(),
		projectId: 7,
		kind: 'WEBGL',
		state: 'VERIFYING',
		generation: 3,
		totalBytes: BigInt(bytes.length),
		bucket: 'protected',
		objectKey: 'protected/uploads/session/generation-3',
		...proof,
		resultAssetId: 41,
		resultRepresentationId: randomUUID(),
		reservedWebglDeploymentId: null,
		sourceRepresentation: {
			id: '',
			assetId: 41,
			role: 'WEBGL_SOURCE',
			state: 'VERIFYING',
			bucket: 'protected',
			objectKey: 'protected/uploads/session/generation-3',
			sizeBytes: BigInt(bytes.length),
			updatedAt: new Date('2026-08-21T00:00:00Z'),
			sourceIdentityAlgorithm: proof.sourceIdentityAlgorithm,
			sourceIdentity: proof.sourceIdentity,
		},
	};
}

async function harness(bytes = unityZip()) {
	const tempRoot = await mkdtemp(join(tmpdir(), 'pcu-webgl-processor-test-'));
	tempRoots.push(tempRoot);
	const uploadSession = session(bytes);
	uploadSession.sourceRepresentation.id = uploadSession.resultRepresentationId;
	const deploymentId = '123e4567-e89b-42d3-a456-426614174000';
	const events: string[] = [];
	const uploaded: Array<{
		key: string;
		type: string;
		encoding?: string;
		cacheControl: string;
		bytes: Buffer;
	}> = [];
	let reservation: ReservedWebglDeployment | undefined;
	const repository = {
		reserveDeployment: vi.fn(async (input: {
			candidateDeploymentId: string;
			publicPrefix: string;
			entryObjectKey: string;
		}) => {
			events.push('reserve');
			reservation ??= {
				id: deploymentId,
				projectId: 7,
				publicBucket: 'public',
				publicPrefix: `public/webgl/7/${deploymentId}/`,
				entryObjectKey: `public/webgl/7/${deploymentId}/index.html`,
				state: 'PENDING',
				expectedCurrentDeploymentId: 'old-deployment',
				outputBucket: 'public',
				outputPrefix: `public/webgl/7/${deploymentId}/`,
				outputEntryObjectKey: `public/webgl/7/${deploymentId}/index.html`,
				publicationStaged: false,
			};
			expect(input.candidateDeploymentId).toMatch(/^[0-9a-f-]{36}$/);
			return reservation;
		}),
		commitReady: vi.fn(async (_input: Parameters<WebglProcessingRepository['commitReady']>[0]): Promise<'COMMITTED' | 'ALREADY_READY' | 'FENCED'> => {
			events.push('commit');
			return 'COMMITTED' as const;
		}),
		rejectFencedAndQueueCleanup: vi.fn(),
	};
	const uploader = {
		put: vi.fn(async (object: {
			objectKey: string;
			body: Readable;
			contentType: string;
			contentEncoding?: string;
			cacheControl: string;
		}) => {
			events.push(`put:${object.objectKey}`);
			const chunks: Buffer[] = [];
			for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
			uploaded.push({
				key: object.objectKey,
				type: object.contentType,
				...(object.contentEncoding ? { encoding: object.contentEncoding } : {}),
				cacheControl: object.cacheControl,
				bytes: Buffer.concat(chunks),
			});
		}),
		head: vi.fn(async (input: { objectKey: string }) => {
			const object = uploaded.find((candidate) => candidate.key === input.objectKey);
			return object ? {
				sizeBytes: object.bytes.length,
				mimeType: object.type,
				etag: `"${createHash('md5').update(object.bytes).digest('hex')}"`,
				checksumSha256: createHash('sha256').update(object.bytes).digest('hex'),
			} : null;
		}),
	};
	const ids = [randomUUID(), randomUUID()];
	const storage = { openSource: vi.fn(async () => ({ body: Readable.from([bytes]), sizeBytes: bytes.length })) };
	const processor = createWebglProcessingProcessor({
		publicBucket: 'public',
		protectedBucket: 'protected',
		tempRoot,
		physicalArchiveByteLimit: 1024 * 1024,
		diskBudget: createWebglTempDiskBudget(2 * 1024 * 1024),
		repository,
		storage,
		uploader,
		ids: { next: () => ids.shift()! },
		logger: { warn: vi.fn() },
	});
	return {
		bytes,
		deploymentId,
		events,
		processor,
		storage,
		repository,
		uploaded,
		uploader,
		uploadSession,
		context: { claimToken: 'claim', signal: new AbortController().signal, assertClaimOwned: vi.fn() },
	};
}

describe('canonical WebGL processing', () => {
	// Synthetic archives verify processing and stored metadata, not Unity execution.
	for (const wrapper of ['', 'UnityBuild/']) {
		for (const configuration of ['plain', 'gzip', 'brotli', 'gzip-fallback', 'brotli-fallback'] as const) {
			it(`preserves payloads and encoding for ${configuration} at ${wrapper || 'ZIP root'}`, async () => {
				const fallback = configuration.endsWith('-fallback');
				const compress = configuration.startsWith('gzip') ? gzipSync
					: configuration.startsWith('brotli') ? brotliCompressSync : (bytes: Buffer) => bytes;
				const suffix = fallback ? '.unityweb' : configuration === 'gzip' ? '.gz'
					: configuration === 'brotli' ? '.br' : '';
				const payloads = ['framework.js', 'wasm', 'data'].map((extension) => ({
					name: `Build/game.${extension}${suffix}`,
					body: compress(Buffer.from(`original ${extension} payload`)),
				}));
				const state = await harness(storedZip([
					{ name: `${wrapper}index.html`, body: '<html>Unity</html>' },
					{ name: `${wrapper}Build/game.loader.js`, body: 'loader' },
					...payloads.map((entry) => ({ ...entry, name: `${wrapper}${entry.name}`, deflate: true })),
				]));
				await state.processor.process(state.uploadSession, state.context);
				const manifest = state.repository.commitReady.mock.calls[0]![0].objectManifest;
				for (const [index, payload] of payloads.entries()) {
					const object = state.uploaded.find((item) => item.key.endsWith(`/${payload.name}`))!;
					const encoding = fallback || configuration === 'plain' ? undefined
						: configuration === 'gzip' ? 'gzip' : 'br';
					expect(object.bytes).toEqual(payload.body);
					expect(object.encoding).toBe(encoding);
					expect(object.type).toBe(fallback || index === 2 ? 'application/octet-stream'
						: index === 0 ? 'text/javascript; charset=utf-8' : 'application/wasm');
					expect(manifest.objects.find((entry) => entry.objectKey === object.key))
						.toMatchObject({ contentEncoding: encoding ?? null });
				}
				expect(state.uploaded).toHaveLength(5);
			});
		}
	}

	it.each(['loader.js', 'framework.js', 'wasm', 'data'])('reports a missing %s before replacing an existing deployment', async (missing) => {
		const entries = [
			{ name: 'index.html', body: '<html>Unity</html>' },
			...['loader.js', 'framework.js', 'wasm', 'data'].filter((extension) => extension !== missing)
				.map((extension) => ({ name: `Build/game.${extension}${extension === 'loader.js' ? '' : '.unityweb'}`, body: 'payload' })),
		];
		const state = await harness(storedZip(entries));
		await expect(state.processor.process(state.uploadSession, state.context))
			.rejects.toThrow(`missing required Unity Build ${missing} artifact (accepted:`);
		expect(state.repository.reserveDeployment).not.toHaveBeenCalled();
		expect(state.uploader.put).not.toHaveBeenCalled();
		expect(state.repository.commitReady).not.toHaveBeenCalled();
	});

	it('keeps a successful deployment current when its replacement ZIP fails validation', async () => {
		const state = await harness();
		let currentDeploymentId = 'old-deployment';
		state.repository.commitReady.mockImplementation(async (input) => {
			currentDeploymentId = input.deploymentId;
			return 'COMMITTED';
		});
		await state.processor.process(state.uploadSession, state.context);
		expect(currentDeploymentId).toBe(state.deploymentId);
		const invalid = storedZip([{ name: 'index.html', body: '<html>missing Build</html>' }]);
		const replacementSession = session(invalid);
		replacementSession.sourceRepresentation.id = replacementSession.resultRepresentationId;
		state.storage.openSource.mockImplementation(async () => ({ body: Readable.from([invalid]), sizeBytes: invalid.length }));
		const puts = state.uploader.put.mock.calls.length;
		await expect(state.processor.process(replacementSession, state.context))
			.rejects.toBeInstanceOf(WebglTerminalValidationError);
		expect(currentDeploymentId).toBe(state.deploymentId);
		expect(state.repository.commitReady).toHaveBeenCalledTimes(1);
		expect(state.repository.reserveDeployment).toHaveBeenCalledTimes(1);
		expect(state.uploader.put).toHaveBeenCalledTimes(puts);
	});

	it('rejects a fallback loader instead of treating it as executable JavaScript', async () => {
		const state = await harness(storedZip([
			{ name: 'index.html', body: '<html>Unity</html>' },
			...['loader.js', 'framework.js', 'wasm', 'data'].map((extension) => ({
				name: `Build/game.${extension}.unityweb`, body: 'payload',
			})),
		]));
		await expect(state.processor.process(state.uploadSession, state.context))
			.rejects.toThrow('missing required Unity Build loader.js artifact');
		expect(state.repository.commitReady).not.toHaveBeenCalled();
		expect(state.uploader.put).not.toHaveBeenCalled();
	});

	it('carries the API-created base64 source manifest through VERIFYING into worker materialization', async () => {
		const state = await harness();
		const proof = identity(state.bytes);
		let persisted: Record<string, unknown> | undefined;
		const repository = {
			expireStaleAllocations: vi.fn(async () => 0),
			createAllocating: vi.fn(async (input) => {
				persisted = input;
				return {
					...state.uploadSession,
					...input,
					state: 'ALLOCATING' as const,
					uploadId: null,
				};
			}),
			setAllocated: vi.fn(async () => true),
		} as unknown as AssetUploadRepository;
		const service = createAssetUploadService({
			repository,
			storage: {
				createMultipart: vi.fn(async () => 'garage-upload'),
				listParts: vi.fn(), completeMultipart: vi.fn(), head: vi.fn(), abortMultipart: vi.fn(),
			},
			partSigner: { presignUploadPart: vi.fn() },
			clock: { now: () => new Date('2026-08-21T00:00:00Z') },
			ids: { next: () => state.uploadSession.id },
			config: {
				bucket: 'protected', sessionTtlMs: 60_000, partSizeBytes: 5 * 1024 * 1024,
				partUrlTtlSeconds: 60, partUrlRefreshMax: 1,
				maxBytesFor: () => 10 * 1024 * 1024,
			},
			authorizeProjectWrite: vi.fn(async () => ({ exhibitionId: 1, status: 'PUBLISHED' })),
			wakeMaintenance: vi.fn(),
		});

		await service.createWebglSession({ id: 11, role: 'USER' }, 7, {
			originalName: 'webgl.zip', totalBytes: state.bytes.length,
			sourceIdentityAlgorithm: proof.sourceIdentityAlgorithm,
			sourceIdentity: proof.sourceIdentity,
			sourceIdentityBlockSizeBytes: proof.sourceIdentityBlockSizeBytes,
			sourceIdentityBlockDigests: proof.sourceIdentityBlockDigests,
		});
		expect(persisted?.sourceIdentityBlockManifest).toBe(proof.sourceIdentityBlockManifest);

		// This is the durable row after CompleteMultipart has atomically advanced it
		// to VERIFYING. The worker receives exactly the API-encoded JSON value.
		Object.assign(state.uploadSession, {
			state: 'VERIFYING',
			bucket: persisted?.bucket,
			objectKey: persisted?.objectKey,
			generation: persisted?.generation,
			sourceIdentityAlgorithm: persisted?.sourceIdentityAlgorithm,
			sourceIdentity: persisted?.sourceIdentity,
			sourceIdentityBlockSizeBytes: persisted?.sourceIdentityBlockSizeBytes,
			sourceIdentityBlockManifest: persisted?.sourceIdentityBlockManifest,
		});
		Object.assign(state.uploadSession.sourceRepresentation, {
			bucket: persisted?.bucket,
			objectKey: persisted?.objectKey,
			sourceIdentityAlgorithm: persisted?.sourceIdentityAlgorithm,
			sourceIdentity: persisted?.sourceIdentity,
		});
		await expect(state.processor.process(state.uploadSession, state.context)).resolves.toMatchObject({
			deploymentId: state.deploymentId,
		});
	});

	it('fully validates before reserving/publishing and commits the immutable generation last', async () => {
		const state = await harness();
		const result = await state.processor.process(state.uploadSession, state.context);
		expect(result).toEqual({
			deploymentId: state.deploymentId,
			publicPrefix: `public/webgl/7/${state.deploymentId}/`,
			entryObjectKey: `public/webgl/7/${state.deploymentId}/index.html`,
		});
		expect(state.events[0]).toBe('reserve');
		expect(state.events.at(-1)).toBe('commit');
		expect(state.uploaded).toHaveLength(5);
		expect(state.uploaded.every((item) => item.cacheControl === 'public, max-age=31536000, immutable')).toBe(true);
		expect(state.uploaded.find((item) => item.key.endsWith('.wasm.br')))
			.toMatchObject({ type: 'application/wasm', encoding: 'br' });
		expect(state.uploaded.find((item) => item.key.endsWith('.data.gz')))
			.toMatchObject({ type: 'application/octet-stream', encoding: 'gzip' });
		expect(state.repository.commitReady).toHaveBeenCalledWith(expect.objectContaining({
			displayAnalysis: { version: 1, kind: 'unknown', width: null, height: null, reason: 'unsupported-document-mode' },
			expectedCurrentDeploymentId: 'old-deployment',
			objectManifest: expect.objectContaining({
				version: 1,
				objects: expect.arrayContaining([
					expect.objectContaining({
						objectKey: `public/webgl/7/${state.deploymentId}/index.html`,
						sizeBytes: '18', mimeType: 'text/html; charset=utf-8', contentEncoding: null,
						etag: expect.any(String), checksumSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
					}),
				]),
			}),
		}));
		expect(state.uploader.head).toHaveBeenCalledTimes(5);
	});

	it('reuses the reserved deployment prefix after an interrupted object publish', async () => {
		const state = await harness();
		state.uploader.put.mockRejectedValueOnce(new Error('Garage restarted'));
		await expect(state.processor.process(state.uploadSession, state.context)).rejects.toThrow('Garage restarted');
		expect(state.repository.commitReady).not.toHaveBeenCalled();
		expect(state.repository.rejectFencedAndQueueCleanup).not.toHaveBeenCalled();

		await expect(state.processor.process(state.uploadSession, state.context)).resolves.toMatchObject({
			deploymentId: state.deploymentId,
		});
		expect(state.repository.reserveDeployment).toHaveBeenCalledTimes(2);
		expect(state.uploaded.every((item) => item.key.startsWith(
			`public/webgl/7/${state.deploymentId}/`,
		))).toBe(true);
	});

	it('converges on the same generation after public PUTs succeed but the DB commit fails', async () => {
		const state = await harness();
		state.repository.commitReady.mockRejectedValueOnce(new Error('database unavailable'));
		await expect(state.processor.process(state.uploadSession, state.context))
			.rejects.toThrow('database unavailable');
		expect(state.repository.rejectFencedAndQueueCleanup).not.toHaveBeenCalled();

		await expect(state.processor.process(state.uploadSession, state.context)).resolves.toMatchObject({
			deploymentId: state.deploymentId,
		});
		expect(state.repository.commitReady).toHaveBeenCalledTimes(2);
		expect(state.repository.commitReady.mock.calls[0]![0].objectManifest).toEqual(
			state.repository.commitReady.mock.calls[1]![0].objectManifest,
		);
		expect(state.uploaded.every((item) => item.key.startsWith(
			`public/webgl/7/${state.deploymentId}/`,
		))).toBe(true);
	});

	it('does not commit READY when post-PUT HEAD cannot recover an exact manifest', async () => {
		const state = await harness();
		state.uploader.head.mockResolvedValueOnce(null);
		await expect(state.processor.process(state.uploadSession, state.context))
			.rejects.toThrow('unavailable for manifest recovery');
		expect(state.repository.commitReady).not.toHaveBeenCalled();
	});

	it('classifies an authoritative WEBGL_SOURCE 404 as terminal validation', async () => {
		const state = await harness();
		const missing = new WorkerSourceObjectMissingError('Canonical WEBGL_SOURCE object does not exist');
		const tempRoot = await mkdtemp(join(tmpdir(), 'pcu-webgl-missing-test-'));
		tempRoots.push(tempRoot);
		// Build a fresh processor seam so the missing response occurs before materialization.
		const processor = createWebglProcessingProcessor({
			publicBucket: 'public', protectedBucket: 'protected', tempRoot,
			physicalArchiveByteLimit: 1024 * 1024, diskBudget: createWebglTempDiskBudget(2 * 1024 * 1024),
			repository: state.repository, storage: { openSource: vi.fn(async () => { throw missing; }) },
			uploader: state.uploader, ids: { next: () => randomUUID() }, logger: { warn: vi.fn() },
		});
		await expect(processor.process(state.uploadSession, state.context))
			.rejects.toBeInstanceOf(WebglTerminalValidationError);
		expect(state.repository.reserveDeployment).not.toHaveBeenCalled();
	});

	it('persists the preflight-compatible manifest in the same READY transaction', async () => {
		const source = await readFile(new URL('../asset-upload/webgl-processing-repository.ts', import.meta.url), 'utf8');
		expect(source).toContain('assertWebglPublishedObjectManifest(');
		expect(source).toMatch(/state: 'READY', error: null,[\s\S]*objectManifest: input\.objectManifest/);
	});

	it('queues exact-prefix cleanup when the final pointer CAS is fenced', async () => {
		const state = await harness();
		state.repository.commitReady.mockResolvedValueOnce('FENCED');
		await expect(state.processor.process(state.uploadSession, state.context))
			.rejects.toBeInstanceOf(WebglGenerationFencedError);
		expect(state.repository.rejectFencedAndQueueCleanup).toHaveBeenCalledWith({
			sessionId: state.uploadSession.id,
			generation: 3,
			claimToken: 'claim',
			publicBucket: 'public',
			publicPrefix: `public/webgl/7/${state.deploymentId}/`,
			reason: 'webgl-current-pointer-fenced',
		});
	});

	it('retries durable prefix cleanup after a cleanup enqueue failure', async () => {
		const state = await harness();
		state.repository.commitReady.mockResolvedValue('FENCED');
		state.repository.rejectFencedAndQueueCleanup
			.mockRejectedValueOnce(new Error('outbox unavailable'))
			.mockResolvedValueOnce(undefined);
		await expect(state.processor.process(state.uploadSession, state.context))
			.rejects.toThrow('outbox unavailable');
		await expect(state.processor.process(state.uploadSession, state.context))
			.rejects.toBeInstanceOf(WebglGenerationFencedError);
		expect(state.repository.rejectFencedAndQueueCleanup).toHaveBeenCalledTimes(2);
	});

	it('publishes a valid Unity build containing highly compressible resources', async () => {
		const state = await harness(storedZip([
				{ name: 'index.html', body: '<html>Unity</html>' },
				{ name: 'Build/game.loader.js', body: 'loader' },
				{ name: 'Build/game.framework.js', body: 'framework' },
				{ name: 'Build/game.wasm', body: 'wasm' },
				{ name: 'Build/game.data', body: 'data' },
				{ name: 'Build/repetitive.unityweb', body: 'x'.repeat(10_000), deflate: true },
		]));
		await state.processor.process(state.uploadSession, state.context);
		expect(state.repository.commitReady).toHaveBeenCalledOnce();
	});

	it('rejects CRC corruption and Unity layout errors before reservation or public PUT', async () => {
		const corrupt = unityZip();
		corrupt[40] = corrupt[40]! ^ 0xff;
		for (const bytes of [
			corrupt,
			storedZip([{ name: 'index.html', body: 'not a Unity build' }]),
		]) {
			const state = await harness(bytes);
			await expect(state.processor.process(state.uploadSession, state.context))
				.rejects.toBeInstanceOf(WebglTerminalValidationError);
			expect(state.repository.reserveDeployment).not.toHaveBeenCalled();
			expect(state.uploader.put).not.toHaveBeenCalled();
			expect(state.repository.commitReady).not.toHaveBeenCalled();
		}
	});

	it('requires the claim adapter to filter WEBGL before leasing a bounded batch', async () => {
		const claim = vi.fn(async (input: { kind: 'WEBGL' }) => {
			expect(input.kind).toBe('WEBGL');
			return [];
		});
		const worker = createWebglProcessingWorker({
			repository: {
				claimVerifyingWebglSessions: claim,
				assertValidationLease: vi.fn(),
				renewValidationLease: vi.fn(),
				releaseValidationLease: vi.fn(),
				rejectInvalidSource: vi.fn(),
			},
			processor: { process: vi.fn() },
			ids: { next: () => 'claim' },
			clock: { now: () => new Date('2026-08-21T00:00:00Z') },
			options: { concurrency: 4, leaseMs: 60_000, heartbeatMs: 10_000 },
			logger: { error: vi.fn() },
		});
		await expect(worker.runPass()).resolves.toEqual({ claimed: 0, ready: 0, rejected: 0, retried: 0 });
		expect(claim).toHaveBeenCalledWith(expect.objectContaining({ kind: 'WEBGL', limit: 4 }));
	});
});
