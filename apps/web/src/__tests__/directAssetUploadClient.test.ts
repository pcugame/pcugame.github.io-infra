/* @vitest-environment jsdom */

import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadDirectAssetFile, createDirectAssetUploadSession, getDirectAssetUploadCreation, isDirectUploadPreCreationRejection } from '../lib/api/game-upload';
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

function creationFields(init?: RequestInit) {
	return { ...JSON.parse(String(init?.body)), kind: 'GAME', state: 'UPLOADING' };
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

	it.each([
		[400, 'ERROR', false], [400, 'VALIDATION_ERROR', false], [400, 'INVALID_FILENAME', false],
		[401, 'UNAUTHORIZED', false], [403, 'FORBIDDEN', false], [404, 'NOT_FOUND', false],
		[413, 'PAYLOAD_TOO_LARGE', false], [415, 'UNSUPPORTED_MEDIA_TYPE', false],
		[400, undefined, true], [400, 'UNKNOWN', true], [408, 'ERROR', true], [422, 'ERROR', true],
		[409, 'CONFLICT', true], [409, 'IDEMPOTENCY_CONFLICT', true],
		[409, 'OPERATION_IN_PROGRESS', true], [503, 'INTERNAL_ERROR', true],
	] as const)('distinguishes create HTTP %s %s by its pre-allocation contract', async (status, code, uncertain) => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { code, message: code } }), { status })));
		const request = { clientUploadId: '11111111-1111-4111-8111-111111111111', originalName: 'game.zip', totalBytes: 3,
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' as const, sourceIdentity: 'a'.repeat(64), sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES, sourceIdentityBlockDigests: ['a'.repeat(64)] };
		const error = await createDirectAssetUploadSession({ type: 'PROJECT', id: 7 }, 'GAME', request).catch(error => error);
		expect(error).toMatchObject({ status });
		expect(error.body.error.code).toBe(code);
		expect(Boolean(error.uncertain)).toBe(uncertain);
		expect(isDirectUploadPreCreationRejection(error)).toBe(!uncertain);
	});
	it('rejects a malformed creation observation rather than interpreting it as absence', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ status: 'unknown' })));
		await expect(getDirectAssetUploadCreation('11111111-1111-4111-8111-111111111111')).rejects.toThrow();
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
					...creationFields(init),
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
		expect(calls.filter(({ url }) => url.includes('/api/admin/')).every(({ init }) => init?.signal !== controller.signal))
			.toBe(true);
	});

	it('delivers a late successful create locator before honoring pause', async () => {
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
		let markCreateStarted!: () => void;
		const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
		let finishCreate!: (response: Response) => void;
		const createResponse = new Promise<Response>((resolve) => { finishCreate = resolve; });
		const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
			void init;
			const url = String(request);
			if (url.endsWith('/api/admin/projects/7/direct-game-upload-sessions')) {
				markCreateStarted();
				return createResponse;
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
		await createStarted;
		const reason = new DOMException('Paused', 'AbortError');
		controller.abort(reason);
		finishCreate(jsonResponse({
			sessionId: 'session-late-create', owner: { type: 'PROJECT', id: 7 }, generation: 1,
			partSizeBytes: 3, totalParts: 1, expiresAt: '2026-08-22T00:00:00.000Z',
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
					...creationFields(fetchMock.mock.calls[0]?.[1]),
		}));

		await expect(upload).rejects.toBe(reason);
		expect(onSession).toHaveBeenCalledOnce();
		expect(onSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-late-create' }));
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]?.[1]?.signal).not.toBe(controller.signal);
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
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
					...creationFields(_init),
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
		expect(calls.every(({ init }) => init?.signal !== controller.signal)).toBe(true);
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

});
