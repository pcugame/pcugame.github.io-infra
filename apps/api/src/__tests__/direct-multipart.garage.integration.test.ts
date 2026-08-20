import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { createS3Client, createS3PresigningClient } from '../lib/s3.js';
import { createObjectStorage } from '../lib/storage.js';
import type { MultipartAbortRepository } from '../modules/multipart-abort/ports.js';
import { createMultipartAbortService } from '../modules/multipart-abort/service.js';

const runStorageIntegration = process.env['RUN_STORAGE_INTEGRATION'] === 'true';

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

	it('sends the browser PUT directly to the public signed host and completes through internal S3 control operations', async () => {
		const key = `integration/direct-multipart/${randomUUID()}/source.zip`;
		const bytes = Buffer.alloc(1024 * 1024, 0x61);
		const uploadId = await storage.createMultipart(bucket, key, 'application/zip');
		let completed = false;
		try {
			const signedUrl = await storage.presignUploadPart!(bucket, key, uploadId, 1, 120);
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

	it('fences an in-flight browser UploadPart even when its HTTP response succeeds after abort', async () => {
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
		const slowBody = Readable.from((async function* slowUploadBody() {
			yield Buffer.alloc(5 * 1024 * 1024, 0x61);
			firstChunkEmitted?.();
			await secondChunkGate;
			yield Buffer.alloc(1024 * 1024, 0x62);
		})());
		try {
			const signedUrl = await storage.presignUploadPart!(bucket, key, uploadId, 1, 120);
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

			// Garage can still return a successful HTTP response to the request that
			// was already in flight. The durable abort task is nevertheless safe to
			// resolve only if the settled request leaves no ListParts/HEAD state.
			await expect(abortWorker.run()).resolves.toEqual({ tried: 1, resolved: 1, failed: 0 });
			expect(resolvedAbortTask).toBe(true);
			releaseSecondChunk?.();
			const latePut = await inFlightPut;
			expect(latePut.ok).toBe(true);
			await expect(storage.listParts(bucket, key, uploadId)).rejects.toBeDefined();
			await expect(storage.head(bucket, key)).resolves.toBeNull();

			// Abort is idempotent for the same uploadId after the settled late PUT.
			await expect(storage.abortMultipart(bucket, key, uploadId)).resolves.toBeUndefined();
		} finally {
			releaseSecondChunk?.();
			await storage.abortMultipart(bucket, key, uploadId).catch(() => undefined);
		}
	});
});
