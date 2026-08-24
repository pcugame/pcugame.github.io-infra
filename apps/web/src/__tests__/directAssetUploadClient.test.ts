/* @vitest-environment jsdom */

import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	uploadDirectAssetFile,
	waitForDirectAssetReady,
} from '../lib/api/game-upload';

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
