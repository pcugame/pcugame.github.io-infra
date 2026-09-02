/* @vitest-environment jsdom */

import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	uploadDirectAssetFile,
	waitForDirectAssetReady,
} from '../lib/api/game-upload';
import {
	createFileSourceIdentity,
	SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
} from '../lib/file-identity';

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify({ ok: true, data }), {
		status: init.status ?? 200,
		statusText: init.statusText,
		headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
	});
}

describe('direct asset upload browser client', () => {
	let installedBlobArrayBuffer = false;
	afterEach(() => {
		if (installedBlobArrayBuffer) {
			delete (Blob.prototype as Partial<Blob>).arrayBuffer;
			installedBlobArrayBuffer = false;
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('hashes and requests a 9-part file in bounded 8+1 batches with no API byte relay', async () => {
		vi.stubGlobal('crypto', webcrypto as unknown as Crypto);
		if (typeof Blob.prototype.arrayBuffer !== 'function') {
			installedBlobArrayBuffer = true;
			Object.defineProperty(Blob.prototype, 'arrayBuffer', {
				configurable: true,
				value(this: Blob) {
					return new Promise<ArrayBuffer>((resolve, reject) => {
						const reader = new FileReader();
						reader.onerror = () => reject(reader.error);
						reader.onload = () => resolve(reader.result as ArrayBuffer);
						reader.readAsArrayBuffer(this);
					});
				},
			});
		}
		const capabilityBatches: number[][] = [];
		let partUrlAttempt = 0;
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/direct-game-upload-sessions')) {
				return jsonResponse({
					sessionId: 'session-1', owner: { type: 'PROJECT', id: 7 }, generation: 1,
					partSizeBytes: 2, totalParts: 9, expiresAt: '2026-08-22T00:00:00.000Z',
					sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
				});
			}
			if (url.endsWith('/api/admin/direct-asset-upload-sessions/session-1/part-urls')) {
				partUrlAttempt += 1;
				if (partUrlAttempt === 1) {
					return new Response(JSON.stringify({ ok: false }), {
						status: 429, statusText: 'Too Many Requests',
						headers: { 'content-type': 'application/json', 'retry-after': '0' },
					});
				}
				const body = JSON.parse(String(init?.body)) as {
					generation: number; parts: Array<{ partNumber: number }>;
				};
				capabilityBatches.push(body.parts.map((part) => part.partNumber));
				return jsonResponse({
					generation: body.generation,
					expiresAt: '2026-08-22T00:00:00.000Z',
					parts: body.parts.map(({ partNumber }) => ({
						partNumber, url: `https://upload.test/${partNumber}`,
						requiredHeaders: { 'x-amz-checksum-sha256': 'signed' },
					})),
				});
			}
			if (url.startsWith('https://upload.test/')) {
				return new Response(null, { status: 200, headers: { etag: `etag-${url.split('/').pop()}` } });
			}
			if (url.endsWith('/api/admin/direct-asset-upload-sessions/session-1/complete')) {
				return jsonResponse({ status: 'READY', sessionId: 'session-1', generation: 1, sizeBytes: 17 });
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		await expect(uploadDirectAssetFile(
			7,
			new File(['12345678901234567'], 'game.zip', { type: 'application/zip' }),
			'GAME',
		)).resolves.toMatchObject({ status: 'READY' });

		expect(capabilityBatches).toEqual([
			[1, 2, 3, 4, 5, 6, 7, 8],
			[9],
		]);
		expect(partUrlAttempt).toBe(3); // 429 retry + two successful batches
		const calls = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init }));
		expect(calls.filter(({ url }) => url.startsWith('https://upload.test/'))).toHaveLength(9);
		for (const { url, init } of calls) {
			if (url.startsWith('http://localhost:4000/api/')) {
				expect(init?.body).not.toBeInstanceOf(Blob);
			}
		}
	});

	it('aborts an in-flight UploadPart without starting another capability, part, or complete request', async () => {
		vi.stubGlobal('crypto', webcrypto as unknown as Crypto);
		if (typeof Blob.prototype.arrayBuffer !== 'function') {
			installedBlobArrayBuffer = true;
			Object.defineProperty(Blob.prototype, 'arrayBuffer', {
				configurable: true,
				value(this: Blob) {
					return new Promise<ArrayBuffer>((resolve, reject) => {
						const reader = new FileReader();
						reader.onerror = () => reject(reader.error);
						reader.onload = () => resolve(reader.result as ArrayBuffer);
						reader.readAsArrayBuffer(this);
					});
				},
			});
		}
		const controller = new AbortController();
		let markPutStarted!: () => void;
		const putStarted = new Promise<void>((resolve) => { markPutStarted = resolve; });
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/direct-game-upload-sessions')) {
				return jsonResponse({
					sessionId: 'session-abort-put', owner: { type: 'PROJECT', id: 7 }, generation: 1,
					partSizeBytes: 3, totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z',
					sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
				});
			}
			if (url.endsWith('/part-urls')) {
				return jsonResponse({
					generation: 1, expiresAt: '2026-08-22T00:00:00.000Z',
					parts: [{ partNumber: 1, url: 'https://upload.test/1', requiredHeaders: {} }],
				});
			}
			if (url === 'https://upload.test/1') {
				markPutStarted();
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
				});
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const upload = uploadDirectAssetFile(
			7,
			new File(['123'], 'game.zip', { type: 'application/zip' }),
			'GAME',
			undefined,
			{ signal: controller.signal },
		);
		await putStarted;
		const reason = new DOMException('Paused', 'AbortError');
		controller.abort(reason);

		await expect(upload).rejects.toBe(reason);
		const calls = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init }));
		expect(calls.filter(({ url }) => url.endsWith('/part-urls'))).toHaveLength(1);
		expect(calls.filter(({ url }) => url.startsWith('https://upload.test/'))).toHaveLength(1);
		expect(calls.some(({ url }) => url.endsWith('/complete'))).toBe(false);
		expect(calls.find(({ url }) => url.startsWith('https://upload.test/'))?.init?.signal)
			.toBe(controller.signal);
		expect(calls.filter(({ url }) => url.includes('/api/admin/')).every(({ init }) => init?.signal === undefined))
			.toBe(true);
	});

	it('aborts an UploadPart 429 backoff without retrying or completing', async () => {
		vi.stubGlobal('crypto', webcrypto as unknown as Crypto);
		if (typeof Blob.prototype.arrayBuffer !== 'function') {
			installedBlobArrayBuffer = true;
			Object.defineProperty(Blob.prototype, 'arrayBuffer', {
				configurable: true,
				value(this: Blob) {
					return new Promise<ArrayBuffer>((resolve, reject) => {
						const reader = new FileReader();
						reader.onerror = () => reject(reader.error);
						reader.onload = () => resolve(reader.result as ArrayBuffer);
						reader.readAsArrayBuffer(this);
					});
				},
			});
		}
		const controller = new AbortController();
		let markThrottled!: () => void;
		const throttled = new Promise<void>((resolve) => { markThrottled = resolve; });
		const fetchMock = vi.fn(async (request: string | URL | Request) => {
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/direct-game-upload-sessions')) {
				return jsonResponse({
					sessionId: 'session-abort-wait', owner: { type: 'PROJECT', id: 7 }, generation: 1,
					partSizeBytes: 3, totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z',
					sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
				});
			}
			if (url.endsWith('/part-urls')) {
				return jsonResponse({
					generation: 1, expiresAt: '2026-08-22T00:00:00.000Z',
					parts: [{ partNumber: 1, url: 'https://upload.test/1', requiredHeaders: {} }],
				});
			}
			if (url === 'https://upload.test/1') {
				markThrottled();
				return new Response(null, { status: 429, headers: { 'retry-after': '60' } });
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const upload = uploadDirectAssetFile(
			7,
			new File(['123'], 'game.zip', { type: 'application/zip' }),
			'GAME',
			undefined,
			{ signal: controller.signal },
		);
		await throttled;
		await Promise.resolve();
		const reason = new DOMException('Paused', 'AbortError');
		controller.abort(reason);

		await expect(upload).rejects.toBe(reason);
		const urls = fetchMock.mock.calls.map(([url]) => String(url));
		expect(urls.filter((url) => url === 'https://upload.test/1')).toHaveLength(1);
		expect(urls.filter((url) => url.endsWith('/part-urls'))).toHaveLength(1);
		expect(urls.some((url) => url.endsWith('/complete'))).toBe(false);
	});

	it('prefers pause over a concurrent capability HTTP failure after preserving the created session', async () => {
		vi.stubGlobal('crypto', webcrypto as unknown as Crypto);
		if (typeof Blob.prototype.arrayBuffer !== 'function') {
			installedBlobArrayBuffer = true;
			Object.defineProperty(Blob.prototype, 'arrayBuffer', {
				configurable: true,
				value(this: Blob) {
					return new Promise<ArrayBuffer>((resolve, reject) => {
						const reader = new FileReader();
						reader.onerror = () => reject(reader.error);
						reader.onload = () => resolve(reader.result as ArrayBuffer);
						reader.readAsArrayBuffer(this);
					});
				},
			});
		}
		const controller = new AbortController();
		const onSession = vi.fn();
		let markCapabilityStarted!: () => void;
		const capabilityStarted = new Promise<void>((resolve) => { markCapabilityStarted = resolve; });
		let finishCapability!: (response: Response) => void;
		const capabilityResponse = new Promise<Response>((resolve) => { finishCapability = resolve; });
		const fetchMock = vi.fn(async (request: string | URL | Request, _init?: RequestInit) => {
			void _init;
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/direct-game-upload-sessions')) {
				return jsonResponse({
					sessionId: 'session-capability-race', owner: { type: 'PROJECT', id: 7 }, generation: 1,
					partSizeBytes: 3, totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z',
					sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
				});
			}
			if (url.endsWith('/part-urls')) {
				markCapabilityStarted();
				return capabilityResponse;
			}
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal('fetch', fetchMock);

		const upload = uploadDirectAssetFile(
			7,
			new File(['123'], 'game.zip', { type: 'application/zip' }),
			'GAME',
			undefined,
			{ signal: controller.signal, onSession },
		);
		await capabilityStarted;
		const reason = new DOMException('Paused', 'AbortError');
		controller.abort(reason);
		finishCapability(new Response(JSON.stringify({ ok: false }), {
			status: 503,
			statusText: 'Service Unavailable',
			headers: { 'content-type': 'application/json' },
		}));

		await expect(upload).rejects.toBe(reason);
		expect(onSession).toHaveBeenCalledOnce();
		expect(onSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-capability-race' }));
		const calls = fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init }));
		expect(calls).toHaveLength(2);
		expect(calls.every(({ init }) => init?.signal === undefined)).toBe(true);
	});

	it('finishes only the current source-identity block after hashing is aborted', async () => {
		const controller = new AbortController();
		let finishFirstDigest!: (value: ArrayBuffer) => void;
		const firstDigest = new Promise<ArrayBuffer>((resolve) => { finishFirstDigest = resolve; });
		let markDigestStarted!: () => void;
		const digestStarted = new Promise<void>((resolve) => { markDigestStarted = resolve; });
		const digest = vi.fn(() => {
			markDigestStarted();
			return firstDigest;
		});
		vi.stubGlobal('crypto', { subtle: { digest } });
		if (typeof Blob.prototype.arrayBuffer !== 'function') {
			installedBlobArrayBuffer = true;
			Object.defineProperty(Blob.prototype, 'arrayBuffer', {
				configurable: true,
				value(this: Blob) {
					return new Promise<ArrayBuffer>((resolve, reject) => {
						const reader = new FileReader();
						reader.onerror = () => reject(reader.error);
						reader.onload = () => resolve(reader.result as ArrayBuffer);
						reader.readAsArrayBuffer(this);
					});
				},
			});
		}
		const identity = createFileSourceIdentity(
			new File([new Uint8Array(SOURCE_IDENTITY_BLOCK_SIZE_BYTES + 1)], 'large.bin'),
			{ signal: controller.signal },
		);
		await digestStarted;
		const reason = new DOMException('Paused', 'AbortError');
		controller.abort(reason);
		finishFirstDigest(new Uint8Array(32).buffer);

		await expect(identity).rejects.toBe(reason);
		expect(digest).toHaveBeenCalledTimes(1);
	});

	it('keeps VERIFYING polling beyond the former ten-minute UI deadline', async () => {
		const now = vi.spyOn(Date, 'now');
		now.mockReturnValueOnce(0).mockReturnValue(11 * 60_000);
		let polls = 0;
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
			sessionId: 'session-long', owner: { type: 'PROJECT', id: 7 }, kind: 'WEBGL',
			state: ++polls === 1 ? 'VERIFYING' : 'READY', generation: 1,
			originalName: 'webgl.zip', totalBytes: 10, partSizeBytes: 5, totalParts: 2,
			expiresAt: '2026-08-22T00:00:00.000Z', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
			sourceIdentity: 'a'.repeat(64), parts: [],
		})));

		await expect(waitForDirectAssetReady('session-long', { intervalMs: 1 }))
			.resolves.toMatchObject({ state: 'READY' });
		expect(polls).toBe(2);
	});
});
