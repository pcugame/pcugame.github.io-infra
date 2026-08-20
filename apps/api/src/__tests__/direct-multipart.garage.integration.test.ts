import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { createS3Client, createS3PresigningClient } from '../lib/s3.js';
import { createObjectStorage } from '../lib/storage.js';
import type { MultipartAbortRepository } from '../modules/multipart-abort/ports.js';
import { createMultipartAbortService } from '../modules/multipart-abort/service.js';

const runStorageIntegration = process.env['RUN_STORAGE_INTEGRATION'] === 'true';
const sha256Base64 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('base64');
const execFileAsync = promisify(execFile);

describe.runIf(runStorageIntegration)('Garage direct multipart browser transport', () => {
	const internalEndpoint = process.env['S3_INTERNAL_ENDPOINT']
		?? process.env['S3_ENDPOINT']
		?? 'http://127.0.0.1:3900';
	const publicSigningEndpoint = process.env['S3_PUBLIC_SIGNING_ENDPOINT']
		?? process.env['S3_ENDPOINT']
		?? 'http://localhost:3900';
	const bucket = process.env['S3_BUCKET_PROTECTED'] ?? 'pcu-protected';
	const internal = createS3Client({
		S3_INTERNAL_ENDPOINT: internalEndpoint,
		S3_REGION: process.env['S3_REGION'] ?? 'garage',
		S3_ACCESS_KEY_ID: process.env['S3_ACCESS_KEY_ID'] ?? '',
		S3_SECRET_ACCESS_KEY: process.env['S3_SECRET_ACCESS_KEY'] ?? '',
		S3_FORCE_PATH_STYLE: true,
	});
	const publicSigner = createS3PresigningClient({
		S3_PUBLIC_SIGNING_ENDPOINT: publicSigningEndpoint,
		S3_REGION: process.env['S3_REGION'] ?? 'garage',
		S3_ACCESS_KEY_ID: process.env['S3_ACCESS_KEY_ID'] ?? '',
		S3_SECRET_ACCESS_KEY: process.env['S3_SECRET_ACCESS_KEY'] ?? '',
		S3_FORCE_PATH_STYLE: true,
	});
	const storage = createObjectStorage(internal, {
		defaultPresignTtlSec: 60,
		presigningClient: publicSigner,
	});

	afterAll(() => {
		storage.close?.();
		internal.destroy();
	});

	it('pins a Garage CLI that exposes the age-based incomplete multipart cleanup command', async () => {
		const { stdout, stderr } = await execFileAsync('docker', [
			'compose', '-f', 'docker-compose.integration.yml', 'exec', '-T', 'garage',
			'/garage', 'bucket', 'cleanup-incomplete-uploads', '--help',
		], { cwd: new URL('../../../..', import.meta.url), encoding: 'utf8' });
		const help = `${stdout}\n${stderr}`;
		expect(help).toContain('cleanup-incomplete-uploads');
		expect(help).toContain('--older-than');
		expect(help).toMatch(/default:\s*1d/i);
	});

	it('does not grant upload CORS headers to an unconfigured origin', async () => {
		const key = `integration/direct-multipart-cors-deny/${randomUUID()}/source.zip`;
		const uploadId = await storage.createMultipart(bucket, key, 'application/zip');
		try {
			const signedUrl = await storage.presignUploadPart!(
				bucket,
				key,
				uploadId,
				1,
				120,
				sha256Base64(Buffer.from('cors-probe')),
			);
			const preflight = await fetch(signedUrl, {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://attacker.invalid',
					'Access-Control-Request-Method': 'PUT',
					'Access-Control-Request-Headers': 'content-type,x-amz-checksum-sha256',
				},
			});

			expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
			expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
			expect(preflight.headers.get('access-control-expose-headers')).toBeNull();
		} finally {
			await storage.abortMultipart(bucket, key, uploadId).catch(() => undefined);
		}
	});

	it('sends the browser PUT directly to the public signed host and completes through internal S3 control operations', async () => {
		const key = `integration/direct-multipart/${randomUUID()}/source.zip`;
		const bytes = Buffer.alloc(1024 * 1024, 0x61);
		const uploadId = await storage.createMultipart(bucket, key, 'application/zip');
		let completed = false;
		try {
			const signedUrl = await storage.presignUploadPart!(
				bucket, key, uploadId, 1, 120, sha256Base64(bytes),
			);
			const signed = new URL(signedUrl);
			const publicEndpoint = new URL(publicSigningEndpoint);
			expect(signed.origin).toBe(publicEndpoint.origin);
			expect(signed.pathname).toBe(`${publicEndpoint.pathname.replace(/\/$/, '')}/${bucket}/${key}`);
			expect(signed.searchParams.get('uploadId')).toBe(uploadId);
			expect(signed.searchParams.get('partNumber')).toBe('1');
			const preflight = await fetch(signedUrl, {
				method: 'OPTIONS',
				headers: {
					Origin: 'http://localhost:5173',
					'Access-Control-Request-Method': 'PUT',
					'Access-Control-Request-Headers': 'content-type',
				},
			});
			expect(preflight.status).toBe(200);
			expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
			expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');
			expect(preflight.headers.get('access-control-allow-headers')).toContain('content-type');

			// This is deliberately a raw browser-equivalent HTTP request to Garage,
			// not an API route or SDK UploadPart call. Successful signature
			// validation proves the public URL's host, path, and query arrived at
			// Garage unchanged.
			const upload = await fetch(signedUrl, {
				method: 'PUT',
				headers: {
					Origin: 'http://localhost:5173',
					// Match GameUploadWidget's requiredHeaders contract exactly.
					'content-type': 'application/octet-stream',
				},
				body: bytes,
			});
			expect(upload.status).toBe(200);
			expect(upload.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
			expect(upload.headers.get('access-control-expose-headers')).toContain('ETag');
			expect(upload.headers.get('etag')).toBeTruthy();

			const parts = await storage.listParts(bucket, key, uploadId);
			expect(parts).toEqual([
				expect.objectContaining({ partNumber: 1, sizeBytes: bytes.length }),
			]);
			await storage.completeMultipart(bucket, key, uploadId, parts);
			completed = true;
			const beforeReplay = await storage.head(bucket, key);
			expect(beforeReplay).toEqual(expect.objectContaining({
				size: bytes.length,
				contentType: 'application/zip',
			}));

			// An UploadPart capability may outlive completion by a short TTL. Garage
			// must reject it once CompleteMultipartUpload consumed this uploadId;
			// success here would permit a stale browser URL to mutate a final key.
			const replay = await fetch(signedUrl, {
				method: 'PUT',
				headers: {
					Origin: 'http://localhost:5173',
					'content-type': 'application/octet-stream',
				},
				body: Buffer.alloc(bytes.length, 0x62),
			});
			expect(replay.ok).toBe(false);
			const afterReplay = await storage.head(bucket, key);
			expect(afterReplay).toEqual(beforeReplay);
		} finally {
			if (completed) await storage.delete(bucket, key);
			else await storage.abortMultipart(bucket, key, uploadId).catch(() => undefined);
		}
	});

	it('buffers an in-flight browser UploadPart and fences it when abort wins', async () => {
		const key = `integration/direct-multipart-abort/${randomUUID()}/source.zip`;
		const uploadId = await storage.createMultipart(bucket, key, 'application/zip');
		let releaseSecondChunk: (() => void) | undefined;
		const secondChunkGate = new Promise<void>((resolve) => { releaseSecondChunk = resolve; });
		let firstChunkEmitted: (() => void) | undefined;
		const firstChunkStarted = new Promise<void>((resolve) => { firstChunkEmitted = resolve; });
		let resolvedAbortTask = false;
		const abortRepository: MultipartAbortRepository = {
			queue: async () => undefined,
			claim: async () => [{
				id: 'garage-integration-abort-task',
				bucket,
				storageKey: key,
				uploadId,
				attemptCount: 0,
			}],
			renew: async () => ({ count: 1 }),
			resolve: async () => { resolvedAbortTask = true; },
			fail: async () => undefined,
		};
		const abortWorker = createMultipartAbortService({
			repository: abortRepository,
			storage,
			clock: { now: () => new Date() },
			ids: { next: () => 'garage-integration-abort-worker' },
			logger: { error: () => {} },
		});
		const firstBody = Buffer.alloc(5 * 1024 * 1024, 0x61);
		const secondBody = Buffer.alloc(1024 * 1024, 0x62);
		const slowBody = Readable.from((async function* slowUploadBody() {
			yield firstBody;
			firstChunkEmitted?.();
			await secondChunkGate;
			yield secondBody;
		})());
		try {
			const signedUrl = await storage.presignUploadPart!(
				bucket, key, uploadId, 1, 120, sha256Base64(Buffer.concat([firstBody, secondBody])),
			);
			const inFlightPut = fetch(signedUrl, {
				method: 'PUT',
				headers: {
					Origin: 'http://localhost:5173',
					'content-type': 'application/octet-stream',
				},
				body: slowBody,
				duplex: 'half',
			} as RequestInit & { duplex: 'half' });
			await firstChunkStarted;

			// nginx has accepted bytes from the browser but has not opened the Garage
			// request yet. Abort therefore consumes the upload ID before the buffered
			// body can reach storage.
			await expect(abortWorker.run()).resolves.toEqual({ tried: 1, resolved: 1, failed: 0 });
			expect(resolvedAbortTask).toBe(true);
			releaseSecondChunk?.();
			const latePut = await inFlightPut;
			expect(latePut.ok).toBe(false);
			await expect(storage.listParts(bucket, key, uploadId)).rejects.toBeDefined();
			await expect(storage.head(bucket, key)).resolves.toBeNull();

			// Abort is idempotent for the same uploadId after the settled late PUT.
			await expect(storage.abortMultipart(bucket, key, uploadId)).resolves.toBeUndefined();
		} finally {
			releaseSecondChunk?.();
			await storage.abortMultipart(bucket, key, uploadId).catch(() => undefined);
		}
	});

	it('rejects an oversized part at the byte-preserving proxy before Garage stores it', async () => {
		const key = `integration/direct-multipart-oversized/${randomUUID()}/source.zip`;
		const uploadId = await storage.createMultipart(bucket, key, 'application/zip');
		try {
			const oversized = Buffer.alloc(10 * 1024 * 1024 + 1, 0x61);
			const signedUrl = await storage.presignUploadPart!(
				bucket, key, uploadId, 1, 120, sha256Base64(oversized),
			);
			const response = await fetch(signedUrl, {
				method: 'PUT',
				headers: {
					Origin: 'http://localhost:5173',
					'content-type': 'application/octet-stream',
				},
				body: oversized,
			});
			expect(response.status).toBe(413);
			await expect(storage.listParts(bucket, key, uploadId)).resolves.toEqual([]);
			await expect(storage.head(bucket, key)).resolves.toBeNull();
		} finally {
			await storage.abortMultipart(bucket, key, uploadId).catch(() => undefined);
		}
	});

	it('requires the browser-settable content type before forwarding an UploadPart', async () => {
		const key = `integration/direct-multipart-content-type/${randomUUID()}/source.zip`;
		const uploadId = await storage.createMultipart(bucket, key, 'application/zip');
		try {
			const bytes = Buffer.alloc(1024, 0x61);
			const signedUrl = await storage.presignUploadPart!(
				bucket, key, uploadId, 1, 120, sha256Base64(bytes),
			);
			const response = await fetch(signedUrl, {
				method: 'PUT',
				headers: {
					Origin: 'http://localhost:5173',
					'content-type': 'application/zip',
				},
				body: bytes,
			});
			expect(response.status).toBe(415);
			await expect(storage.listParts(bucket, key, uploadId)).resolves.toEqual([]);
		} finally {
			await storage.abortMultipart(bucket, key, uploadId).catch(() => undefined);
		}
	});

	it('binds the presigned capability to the expected SHA-256 checksum', async () => {
		const key = `integration/direct-multipart-checksum/${randomUUID()}/source.zip`;
		const uploadId = await storage.createMultipart(bucket, key, 'application/zip');
		const expected = Buffer.alloc(1024, 0x61);
		try {
			const signedUrl = await storage.presignUploadPart!(
				bucket, key, uploadId, 1, 120, sha256Base64(expected),
			);
			const response = await fetch(signedUrl, {
				method: 'PUT',
				headers: {
					Origin: 'http://localhost:5173',
					'content-type': 'application/octet-stream',
				},
				body: Buffer.alloc(expected.length, 0x62),
			});
			expect(response.status).toBe(400);
			await expect(storage.listParts(bucket, key, uploadId)).resolves.toEqual([]);
		} finally {
			await storage.abortMultipart(bucket, key, uploadId).catch(() => undefined);
		}
	});

	it('rejects an expired UploadPart capability without creating a Garage part', async () => {
		const key = `integration/direct-multipart-expired/${randomUUID()}/source.zip`;
		const uploadId = await storage.createMultipart(bucket, key, 'application/zip');
		try {
			const bytes = Buffer.alloc(1024, 0x61);
			const signedUrl = await storage.presignUploadPart!(
				bucket, key, uploadId, 1, 1, sha256Base64(bytes),
			);
			await delay(2_100);
			const response = await fetch(signedUrl, {
				method: 'PUT',
				headers: {
					Origin: 'http://localhost:5173',
					'content-type': 'application/octet-stream',
				},
				body: bytes,
			});
			expect(response.ok).toBe(false);
			expect([400, 403]).toContain(response.status);
			await expect(storage.listParts(bucket, key, uploadId)).resolves.toEqual([]);
			await expect(storage.head(bucket, key)).resolves.toBeNull();
		} finally {
			await storage.abortMultipart(bucket, key, uploadId).catch(() => undefined);
		}
	}, 10_000);

	it('makes sequential and concurrent replay of the same checksum-bound part deterministic', async () => {
		const key = `integration/direct-multipart-repeated/${randomUUID()}/source.zip`;
		const uploadId = await storage.createMultipart(bucket, key, 'application/zip');
		try {
			const bytes = Buffer.alloc(1024 * 1024, 0x63);
			const signedUrl = await storage.presignUploadPart!(
				bucket, key, uploadId, 1, 120, sha256Base64(bytes),
			);
			const put = () => fetch(signedUrl, {
				method: 'PUT',
				headers: {
					Origin: 'http://localhost:5173',
					'content-type': 'application/octet-stream',
				},
				body: bytes,
			});

			const first = await put();
			const replay = await put();
			expect(first.status).toBe(200);
			expect(replay.status).toBe(200);
			expect(replay.headers.get('etag')).toBe(first.headers.get('etag'));

			const concurrent = await Promise.all([put(), put()]);
			expect(concurrent.map(({ status }) => status)).toEqual([200, 200]);
			const responseEtags = [first, replay, ...concurrent]
				.map((response) => response.headers.get('etag'));
			expect(new Set(responseEtags).size).toBe(1);
			const parts = await storage.listParts(bucket, key, uploadId);
			expect(parts).toEqual([{
				partNumber: 1,
				etag: first.headers.get('etag'),
				sizeBytes: bytes.length,
			}]);
		} finally {
			await storage.abortMultipart(bucket, key, uploadId).catch(() => undefined);
		}
	}, 15_000);

	it('keeps the completed object immutable when Complete wins against a buffered replacement PUT', async () => {
		const key = `integration/direct-multipart-complete-race/${randomUUID()}/source.zip`;
		const uploadId = await storage.createMultipart(bucket, key, 'application/zip');
		const original = Buffer.alloc(5 * 1024 * 1024, 0x64);
		const replacementFirst = Buffer.alloc(5 * 1024 * 1024, 0x65);
		const replacementSecond = Buffer.alloc(1024 * 1024, 0x66);
		const replacement = Buffer.concat([replacementFirst, replacementSecond]);
		let releaseSecondChunk: (() => void) | undefined;
		const secondChunkGate = new Promise<void>((resolve) => { releaseSecondChunk = resolve; });
		let firstChunkEmitted: (() => void) | undefined;
		const firstChunkStarted = new Promise<void>((resolve) => { firstChunkEmitted = resolve; });
		let completed = false;
		try {
			const originalUrl = await storage.presignUploadPart!(
				bucket, key, uploadId, 1, 120, sha256Base64(original),
			);
			const originalPut = await fetch(originalUrl, {
				method: 'PUT',
				headers: {
					Origin: 'http://localhost:5173',
					'content-type': 'application/octet-stream',
				},
				body: original,
			});
			expect(originalPut.status).toBe(200);
			const manifest = await storage.listParts(bucket, key, uploadId);
			expect(manifest).toHaveLength(1);

			const replacementUrl = await storage.presignUploadPart!(
				bucket, key, uploadId, 1, 120, sha256Base64(replacement),
			);
			const slowBody = Readable.from((async function* slowUploadBody() {
				yield replacementFirst;
				firstChunkEmitted?.();
				await secondChunkGate;
				yield replacementSecond;
			})());
			const inFlightPut = fetch(replacementUrl, {
				method: 'PUT',
				headers: {
					Origin: 'http://localhost:5173',
					'content-type': 'application/octet-stream',
				},
				body: slowBody,
				duplex: 'half',
			} as RequestInit & { duplex: 'half' });
			await firstChunkStarted;

			await storage.completeMultipart(bucket, key, uploadId, manifest);
			completed = true;
			releaseSecondChunk?.();
			const latePut = await inFlightPut;
			expect(latePut.ok).toBe(false);
			const final = await storage.readRange(bucket, key, 0, original.length - 1);
			expect(final).toEqual(original);
			await expect(storage.head(bucket, key)).resolves.toEqual(expect.objectContaining({
				size: original.length,
				contentType: 'application/zip',
			}));
		} finally {
			releaseSecondChunk?.();
			if (completed) await storage.delete(bucket, key);
			else await storage.abortMultipart(bucket, key, uploadId).catch(() => undefined);
		}
	}, 20_000);
});
