/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	listGameUploadSessions,
	uploadGameFile,
	type GameUploadSession,
} from '../lib/api/game-upload';

vi.mock('../lib/upload', () => ({
	startUpload: vi.fn(() => 'upload-test'),
	updateUpload: vi.fn(),
	finishUpload: vi.fn(),
	failUpload: vi.fn(),
}));

const IDENTITY = 'a'.repeat(64);

function session(totalChunks = 1): GameUploadSession {
	return {
		sessionId: 'session-direct',
		chunkSizeBytes: 2,
		totalChunks,
		expiresAt: '2026-08-21T00:00:00.000Z',
		uploadKind: 'GAME',
		generation: 7,
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
		sourceIdentity: IDENTITY,
		sourceIdentityBlockSizeBytes: 1048576,
	};
}

function fileForParts(totalChunks: number): File {
	return new File([new Uint8Array(totalChunks * 2).fill(0x61)], 'game.zip', {
		type: 'application/zip',
	});
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify({ ok: true, data }), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function uploaded(etag: string): Response {
	return new Response(null, { status: 200, headers: { etag } });
}

function apiPath(input: RequestInfo | URL): string {
	return new URL(String(input)).pathname;
}

function requestBody(init?: RequestInit): Record<string, unknown> {
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function requestedPartNumbers(init?: RequestInit): number[] {
	const body = requestBody(init);
	return (body.parts as Array<{ partNumber: number }>).map(({ partNumber }) => partNumber);
}

beforeEach(() => {
	vi.restoreAllMocks();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('direct multipart game upload', () => {
	it('does not reinterpret an old status without required uploadKind as GAME', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => json({
			items: [{ sessionId: 'old-response-without-kind' }],
		})));

		await expect(listGameUploadSessions(7, 'GAME')).resolves.toEqual({ items: [] });
	});

	it('uploads browser bytes only to signed Garage URLs and polls VERIFYING to completion', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		let statusCalls = 0;
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.includes('/part-urls')) {
				const partNumbers = requestedPartNumbers(init);
				return json({
					generation: 7,
					expiresAt: '2026-08-20T01:00:00.000Z',
					parts: partNumbers.map((partNumber) => ({
						partNumber,
						url: `https://garage.example/upload/${partNumber}?signed=yes`,
						requiredHeaders: { 'content-type': 'application/octet-stream' },
					})),
				});
			}
			if (url.startsWith('https://garage.example/')) {
				return uploaded(`"etag-${url.match(/upload\/(\d+)/)?.[1]}"`);
			}
			if (url.endsWith('/complete')) {
				const completionCalls = calls.filter(({ url: calledUrl }) => calledUrl.endsWith('/complete')).length;
				return completionCalls === 1
					? json({ status: 'VERIFYING', sessionId: 'session-direct', generation: 7, sizeBytes: 6 }, 202)
					: json({ status: 'COMPLETED', sessionId: 'session-direct', generation: 7, sizeBytes: 6, uploadKind: 'GAME', assetId: 11 });
			}
			if (apiPath(input).endsWith('/session-direct')) {
				statusCalls++;
				return json({ status: 'COMPLETED' });
			}
			throw new Error(`Unexpected URL: ${url}`);
		}));

		const result = await uploadGameFile(fileForParts(3), session(3), { title: 'game' }).start();

		expect(result.status).toBe('COMPLETED');
		expect(statusCalls).toBe(1);
		expect(calls.some(({ url }) => url.includes('/chunks/'))).toBe(false);
		const garageCalls = calls.filter(({ url }) => url.startsWith('https://garage.example/'));
		expect(garageCalls).toHaveLength(3);
		expect(garageCalls.every(({ init }) => init?.method === 'PUT' && init.body instanceof Blob)).toBe(true);
		const completionCalls = calls.filter(({ url }) => url.endsWith('/complete'));
		expect(completionCalls).toHaveLength(2);
		const complete = completionCalls[0];
		expect(requestBody(complete?.init)).toEqual({
			generation: 7,
			parts: [
				{ partNumber: 1, etag: '"etag-1"', sizeBytes: 2 },
				{ partNumber: 2, etag: '"etag-2"', sizeBytes: 2 },
				{ partNumber: 3, etag: '"etag-3"', sizeBytes: 2 },
			],
		});
	});

	it('bounds browser PUT concurrency to four', async () => {
		let active = 0;
		let maximum = 0;
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('/part-urls')) {
				const partNumbers = requestedPartNumbers(init);
				return json({ generation: 7, expiresAt: 'later', parts: partNumbers.map((partNumber) => ({
					partNumber,
					url: `https://garage.example/${partNumber}`,
					requiredHeaders: { 'content-type': 'application/octet-stream' },
				})) });
			}
			if (url.startsWith('https://garage.example/')) {
				active++;
				maximum = Math.max(maximum, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active--;
				return uploaded(`"${url.split('/').at(-1)}"`);
			}
			if (url.endsWith('/complete')) {
				return json({ status: 'COMPLETED', sessionId: 'session-direct', generation: 7, sizeBytes: 20, uploadKind: 'GAME', assetId: 11 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		}));

		await uploadGameFile(fileForParts(10), session(10), { title: 'game' }).start();
		expect(maximum).toBe(4);
	});

	it('re-signs an expired part after 403 and retries only that direct PUT', async () => {
		let signCalls = 0;
		const urls: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			urls.push(url);
			if (url.includes('/part-urls')) {
				signCalls++;
				return json({ generation: 7, expiresAt: 'later', parts: [{
					partNumber: 1,
					url: `https://garage.example/${signCalls === 1 ? 'expired' : 'fresh'}`,
					requiredHeaders: { 'content-type': 'application/octet-stream' },
				}] });
			}
			if (url.endsWith('/expired')) return new Response(null, { status: 403 });
			if (url.endsWith('/fresh')) return uploaded('"fresh-etag"');
			if (url.endsWith('/complete')) {
				return json({ status: 'COMPLETED', sessionId: 'session-direct', generation: 7, sizeBytes: 2, uploadKind: 'GAME', assetId: 11 });
			}
			throw new Error(`Unexpected URL: ${url} ${String(init?.method)}`);
		}));

		await uploadGameFile(fileForParts(1), session(), { title: 'game' }).start();
		expect(signCalls).toBe(2);
		expect(urls.some((url) => url.includes('/chunks/'))).toBe(false);
		expect(urls.filter((url) => url.startsWith('https://garage.example/'))).toEqual([
			'https://garage.example/expired',
			'https://garage.example/fresh',
		]);
	});

	it('fails clearly when Garage CORS does not expose ETag and never falls back to proxy', async () => {
		const urls: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url.includes('/part-urls')) return json({
				generation: 7,
				expiresAt: 'later',
				parts: [{ partNumber: 1, url: 'https://garage.example/no-etag', requiredHeaders: {} }],
			});
			if (url.startsWith('https://garage.example/')) return new Response(null, { status: 200 });
			throw new Error(`Unexpected URL: ${url}`);
		}));

		await expect(uploadGameFile(fileForParts(1), session(), { title: 'game' }).start())
			.rejects.toThrow('ETag');
		expect(urls.some((url) => url.includes('/chunks/'))).toBe(false);
		expect(urls.some((url) => url.endsWith('/complete'))).toBe(false);
	});

	it.each([
		['a stale generation', 6, [1, 2], 'generation'],
		['an incomplete part set', 7, [1], 'part 목록'],
	])('rejects %s signing response before sending any PUT', async (_label, generation, returnedParts, message) => {
		const urls: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (url.includes('/part-urls')) return json({
				generation,
				expiresAt: 'later',
				parts: returnedParts.map((partNumber) => ({
					partNumber,
					url: `https://garage.example/${partNumber}`,
					requiredHeaders: {},
				})),
			});
			throw new Error(`Unexpected URL: ${url}`);
		}));

		await expect(uploadGameFile(fileForParts(2), session(2), { title: 'game' }).start())
			.rejects.toThrow(message);
		expect(urls.some((url) => url.startsWith('https://garage.example/'))).toBe(false);
	});

	it('aborts and settles sibling PUTs before rejecting a failed batch', async () => {
		let releaseMissingEtag: (() => void) | undefined;
		let siblingSignal: AbortSignal | undefined;
		let activePuts = 0;
		const progress: number[] = [];
		const urls: string[] = [];
		vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			urls.push(url);
			if (url.includes('/part-urls')) return Promise.resolve(json({
				generation: 7,
				expiresAt: 'later',
				parts: [1, 2].map((partNumber) => ({
					partNumber,
					url: `https://garage.example/deferred/${partNumber}`,
					requiredHeaders: {},
				})),
			}));
			if (url.endsWith('/deferred/1')) {
				activePuts++;
				return new Promise<Response>((resolve) => {
					releaseMissingEtag = () => {
						activePuts--;
						resolve(new Response(null, { status: 200 }));
					};
				});
			}
			if (url.endsWith('/deferred/2')) {
				activePuts++;
				siblingSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					siblingSignal?.addEventListener('abort', () => {
						activePuts--;
						reject(new DOMException('Aborted', 'AbortError'));
					}, { once: true });
				});
			}
			return Promise.reject(new Error(`Unexpected URL: ${url}`));
		}));

		const controller = uploadGameFile(fileForParts(2), session(2), {
			title: 'game',
			onProgress: (value) => progress.push(value.uploadedChunks),
		});
		const started = controller.start();
		await vi.waitFor(() => {
			expect(activePuts).toBe(2);
			expect(releaseMissingEtag).toBeDefined();
		});
		releaseMissingEtag?.();

		await expect(started).rejects.toThrow('ETag');
		expect(siblingSignal?.aborted).toBe(true);
		expect(activePuts).toBe(0);
		const progressAtRejection = [...progress];
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(progress).toEqual(progressAtRejection);
		expect(progress).toEqual([0]);
		expect(urls.some((url) => url.endsWith('/complete') || url.includes('/chunks/'))).toBe(false);
	});

	it('connects abort() to the in-flight browser-to-Garage PUT', async () => {
		let putSignal: AbortSignal | undefined;
		vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('/part-urls')) return Promise.resolve(json({
				generation: 7,
				expiresAt: 'later',
				parts: [{ partNumber: 1, url: 'https://garage.example/slow', requiredHeaders: {} }],
			}));
			if (url.startsWith('https://garage.example/')) {
				putSignal = init?.signal ?? undefined;
				return new Promise<Response>((_resolve, reject) => {
					putSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
				});
			}
			return Promise.reject(new Error(`Unexpected URL: ${url}`));
		}));

		const controller = uploadGameFile(fileForParts(1), session(), { title: 'game' });
		const started = controller.start();
		await vi.waitFor(() => expect(putSignal).toBeDefined());
		controller.abort();

		await expect(started).rejects.toThrow('Upload aborted');
		expect(putSignal?.aborted).toBe(true);
	});

	it('resumes from Garage-reconciled parts without re-uploading successful parts', async () => {
		const signedBatches: number[][] = [];
		const garageUrls: string[] = [];
		let completionBody: Record<string, unknown> | undefined;
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('/part-urls')) {
				const partNumbers = requestedPartNumbers(init);
				signedBatches.push(partNumbers);
				return json({ generation: 7, expiresAt: 'later', parts: partNumbers.map((partNumber) => ({
					partNumber, url: `https://garage.example/${partNumber}`, requiredHeaders: {},
				})) });
			}
			if (url.startsWith('https://garage.example/')) {
				garageUrls.push(url);
				return uploaded('"etag-2"');
			}
			if (url.endsWith('/complete')) {
				completionBody = requestBody(init);
				return json({ status: 'COMPLETED', sessionId: 'session-direct', generation: 7, sizeBytes: 4, uploadKind: 'GAME', assetId: 11 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		}));

		await uploadGameFile(fileForParts(2), session(2), {
			title: 'game',
			resumeParts: [{ partNumber: 1, etag: '"etag-1"', sizeBytes: 2 }],
		}).start();

		expect(signedBatches).toEqual([[2]]);
		expect(garageUrls).toEqual(['https://garage.example/2']);
		expect(completionBody?.parts).toEqual([
			{ partNumber: 1, etag: '"etag-1"', sizeBytes: 2 },
			{ partNumber: 2, etag: '"etag-2"', sizeBytes: 2 },
		]);
	});

	it('resumes VERIFYING by polling and idempotently reading the final result without another PUT', async () => {
		const urls: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (apiPath(input).endsWith('/session-direct')) return json({ status: 'COMPLETED' });
			if (url.endsWith('/complete')) {
				return json({ status: 'COMPLETED', sessionId: 'session-direct', generation: 7, sizeBytes: 2, uploadKind: 'GAME', assetId: 11 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		}));

		const result = await uploadGameFile(fileForParts(1), session(), {
			title: 'game',
			resumeFinalizationStatus: 'VERIFYING',
		}).start();

		expect(result.status).toBe('COMPLETED');
		expect(urls.some((url) => url.includes('/part-urls'))).toBe(false);
		expect(urls.some((url) => url.startsWith('https://garage.example/'))).toBe(false);
	});

	it('re-completes with Garage-reconciled parts when ambiguity recovery returns PENDING', async () => {
		let statusCalls = 0;
		const completionBodies: Record<string, unknown>[] = [];
		const urls: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			urls.push(url);
			if (apiPath(input).endsWith('/session-direct')) {
				statusCalls++;
				return statusCalls === 1
					? json({
						status: 'PENDING',
						generation: 7,
						totalChunks: 2,
						parts: [
							{ partNumber: 2, etag: '"etag-2"', sizeBytes: 2 },
							{ partNumber: 1, etag: '"etag-1"', sizeBytes: 2 },
						],
					})
					: json({ status: 'COMPLETED', generation: 7 });
			}
			if (url.endsWith('/complete')) {
				completionBodies.push(requestBody(init));
				return completionBodies.length === 1
					? json({ status: 'VERIFYING', sessionId: 'session-direct', generation: 7, sizeBytes: 4 }, 202)
					: json({ status: 'COMPLETED', sessionId: 'session-direct', generation: 7, sizeBytes: 4, uploadKind: 'GAME', assetId: 11 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		}));

		const result = await uploadGameFile(fileForParts(2), session(2), {
			title: 'game',
			resumeFinalizationStatus: 'VERIFYING',
		}).start();

		expect(result.status).toBe('COMPLETED');
		expect(statusCalls).toBe(2);
		expect(completionBodies).toEqual([
			{
				generation: 7,
				parts: [
					{ partNumber: 1, etag: '"etag-1"', sizeBytes: 2 },
					{ partNumber: 2, etag: '"etag-2"', sizeBytes: 2 },
				],
			},
			{
				generation: 7,
				parts: [
					{ partNumber: 1, etag: '"etag-1"', sizeBytes: 2 },
					{ partNumber: 2, etag: '"etag-2"', sizeBytes: 2 },
				],
			},
		]);
		expect(urls.some((url) => url.includes('/part-urls') || url.includes('/chunks/'))).toBe(false);
		expect(urls.some((url) => url.startsWith('https://garage.example/'))).toBe(false);
	});

	it('stops safely when PENDING ambiguity recovery has an incomplete part manifest', async () => {
		const urls: string[] = [];
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			if (apiPath(input).endsWith('/session-direct')) return json({
				status: 'PENDING',
				generation: 7,
				totalChunks: 2,
				parts: [{ partNumber: 1, etag: '"etag-1"', sizeBytes: 2 }],
			});
			throw new Error(`Unexpected URL: ${url}`);
		}));

		await expect(uploadGameFile(fileForParts(2), session(2), {
			title: 'game',
			resumeFinalizationStatus: 'COMPLETING',
		}).start()).rejects.toThrow('part가 부족합니다');

		expect(urls.filter((url) => url.endsWith('/complete'))).toHaveLength(0);
		expect(urls.some((url) => url.includes('/part-urls') || url.includes('/chunks/'))).toBe(false);
		expect(urls.some((url) => url.startsWith('https://garage.example/'))).toBe(false);
	});

	it('signs uploads in batches accepted by the minimum API setting', async () => {
		const batchSizes: number[] = [];
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('/part-urls')) {
				const partNumbers = requestedPartNumbers(init);
				batchSizes.push(partNumbers.length);
				return json({ generation: 7, expiresAt: 'later', parts: partNumbers.map((partNumber) => ({
					partNumber, url: `https://garage.example/${partNumber}`, requiredHeaders: {},
				})) });
			}
			if (url.startsWith('https://garage.example/')) return uploaded(`"${url.split('/').at(-1)}"`);
			if (url.endsWith('/complete')) {
				return json({ status: 'COMPLETED', sessionId: 'session-direct', generation: 7, sizeBytes: 40, uploadKind: 'GAME', assetId: 11 });
			}
			throw new Error(`Unexpected URL: ${url}`);
		}));

		await uploadGameFile(fileForParts(9), session(9), { title: 'game' }).start();
		expect(batchSizes).toEqual([8, 1]);
	});
});
