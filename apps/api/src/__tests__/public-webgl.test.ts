import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type {
	ObjectStreamOutcome,
	ObjectStreamRequest,
	ObjectStreamResult,
} from '../application/ports.js';
import {
	createPublicWebglService,
	normalizeWebglRequestPath,
	normalizeIfNoneMatch,
	type PublicWebglRequestHeaders,
	type PublicWebglStorage,
} from '../modules/public/webgl.service.js';

const deployment = '123e4567-e89b-42d3-a456-426614174000';
const storageKey = `webgl/7/${deployment}/site/Build/game.wasm.br`;
const content = Buffer.from('0123456789');
const etag = '"etag-1"';
const lastModified = new Date('2026-08-12T01:02:03.000Z');

function objectResult(
	body = Readable.from([content]),
	overrides: Partial<ObjectStreamResult> = {},
): ObjectStreamResult {
	return {
		body,
		size: content.byteLength,
		contentType: 'application/wasm',
		etag,
		lastModified,
		...overrides,
	};
}

function serviceHarness() {
	const findPublicWebglProject = vi.fn(async () => ({
		id: 7,
		webglEntryKey: `webgl/7/${deployment}/site/index.html`,
	}));
	const head = vi.fn(async (): Promise<Awaited<ReturnType<PublicWebglStorage['head']>>> => ({
		size: content.byteLength,
		contentType: 'application/wasm',
		etag,
		lastModified,
	}));
	const stream = vi.fn(async (
		..._args: Parameters<PublicWebglStorage['stream']>
	): Promise<ObjectStreamOutcome> => objectResult());
	const service = createPublicWebglService({
		config: {
			apiPublicUrl: 'https://api.example.test',
			webPublicUrl: 'https://web.example.test',
			publicBucket: 'public',
		},
		repository: { findPublicWebglProject },
		storage: { head, stream } as unknown as PublicWebglStorage,
	});
	return { service, findPublicWebglProject, head, stream };
}

async function bodyBuffer(body: unknown): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks);
}

describe('WebGL request path and range parsing', () => {
	it('rejects traversal and backslash traversal after URL decoding', () => {
		expect(() => normalizeWebglRequestPath('../source.zip')).toThrow('Invalid WebGL asset path');
		expect(() => normalizeWebglRequestPath('Build\\..\\source.zip')).toThrow('Invalid WebGL asset path');
	});

});

describe('public WebGL streamed response contract', () => {
	it('serves an ordinary GET with one DB lookup, no HEAD, one GET, and complete metadata', async () => {
		const harness = serviceHarness();
		const body = new PassThrough();
		harness.stream.mockResolvedValueOnce(objectResult(body));

		const response = await harness.service.get(7, 'Build/game.wasm.br');

		expect(response).toMatchObject({
			status: 200,
			headers: {
				'Accept-Ranges': 'bytes',
				'Cache-Control': 'public, max-age=300, must-revalidate',
				'Content-Type': 'application/wasm',
				'Content-Encoding': 'br',
				'Content-Length': '10',
				ETag: etag,
				'Last-Modified': 'Wed, 12 Aug 2026 01:02:03 GMT',
			},
		});
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(response.body).toBe(body);
		expect(body.listenerCount('data')).toBe(0);
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, undefined);
		body.destroy();
	});

	it.each([
		['304', { kind: 'not-modified', etag } as const],
		['412', { kind: 'precondition-failed' } as const],
	])('rejects a typed %s outcome from an unconditional GET', async (_label, outcome) => {
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce(outcome);

		await expect(harness.service.get(7, 'Build/game.wasm.br')).rejects.toThrow(
			/unconditional request/,
		);
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, undefined);
		expect(harness.head).not.toHaveBeenCalled();
	});

	it.each([
		['closed', 'bytes=2-5', { range: { kind: 'closed', start: 2n, end: 5n } }, 'bytes 2-5/10', '2345'],
		['open-ended', 'bytes=4-', { range: { kind: 'open', start: 4n } }, 'bytes 4-9/10', '456789'],
		['suffix', 'bytes=-3', { range: { kind: 'suffix', length: 3n } }, 'bytes 7-9/10', '789'],
	] as const)('serves a %s native range with one GET and no HEAD', async (
		_label,
		range,
		expectedStorageRange,
		contentRange,
		expectedBody,
	) => {
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce(objectResult(
			Readable.from([Buffer.from(expectedBody)]),
			{ size: expectedBody.length, contentRange },
		));

		const response = await harness.service.get(7, 'Build/game.wasm.br', { range });

		expect(response.status).toBe(206);
		expect(response.headers).toMatchObject({
			'Content-Range': contentRange,
			'Content-Length': String(expectedBody.length),
			'Accept-Ranges': 'bytes',
			ETag: etag,
			'Last-Modified': 'Wed, 12 Aug 2026 01:02:03 GMT',
		});
		await expect(bodyBuffer(response.body)).resolves.toEqual(Buffer.from(expectedBody));
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, expectedStorageRange);
	});

	it('rejects a tagged not-modified outcome from a Range-only request', async () => {
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce({ kind: 'not-modified', etag });

		await expect(harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
		})).rejects.toThrow(/without an ordinary validator/);
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			range: { kind: 'closed', start: 2n, end: 5n },
		});
		expect(harness.head).not.toHaveBeenCalled();
	});

	it('rejects a malformed or multiple range after one metadata lookup and without GET', async () => {
		for (const range of ['bytes=1-2,4-5', 'items=1-2', 'bytes=-']) {
			const harness = serviceHarness();
			const response = await harness.service.get(7, 'Build/game.wasm.br', { range });
			expect(response).toMatchObject({
				status: 416,
				headers: { 'Content-Range': 'bytes */10', 'Accept-Ranges': 'bytes' },
			});
			expect(response.body).toBeUndefined();
			expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
			expect(harness.head).toHaveBeenCalledOnce();
			expect(harness.stream).not.toHaveBeenCalled();
		}
	});

	it.each([
		[
			'If-None-Match',
			{ range: 'bytes=1-2,4-5', ifNoneMatch: 'W/"etag-1"' },
		],
		[
			'If-Modified-Since',
			{
				range: 'items=1-2',
				ifModifiedSince: 'Wed, 12 Aug 2026 01:02:03 GMT',
			},
		],
	] as const)('gives a matching %s precondition priority over a malformed range', async (
		_label,
		headers,
	) => {
		const harness = serviceHarness();
		const response = await harness.service.get(7, 'Build/game.wasm.br', headers);

		expect(response.status).toBe(304);
		expect(response.body).toBeUndefined();
		expect(response.headers).toMatchObject({
			'Cache-Control': 'public, max-age=300, must-revalidate',
			ETag: etag,
			'Last-Modified': 'Wed, 12 Aug 2026 01:02:03 GMT',
		});
		expect(response.headers).not.toHaveProperty('Content-Length');
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).toHaveBeenCalledOnce();
		expect(harness.stream).not.toHaveBeenCalled();
	});

	it('keeps malformed Range at 416 when If-None-Match misses and suppresses IMS', async () => {
		const harness = serviceHarness();
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=1-2,4-5',
			ifNoneMatch: '"different"',
			ifModifiedSince: 'Wed, 12 Aug 2099 01:02:03 GMT',
		});

		expect(response).toMatchObject({
			status: 416,
			headers: { 'Content-Range': 'bytes */10' },
		});
		expect(response.body).toBeUndefined();
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).toHaveBeenCalledOnce();
		expect(harness.stream).not.toHaveBeenCalled();
	});

	it('uses the one native GET typed outcome for a valid but unsatisfiable range', async () => {
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce({
			kind: 'range-not-satisfiable',
			size: 10,
			contentRange: 'bytes */10',
			etag,
			lastModified,
		});

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=10-',
		});

		expect(response).toMatchObject({
			status: 416,
			headers: {
				'Content-Range': 'bytes */10',
				ETag: etag,
				'Last-Modified': 'Wed, 12 Aug 2026 01:02:03 GMT',
			},
		});
		expect(response.body).toBeUndefined();
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			range: { kind: 'open', start: 10n },
		});
	});

	it.each([
		'bytes=9007199254740992-',
		'bytes=9007199254740992-9007199254740993',
	])('delegates a syntactically valid huge range to one native GET: %s', async (range) => {
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce({
			kind: 'range-not-satisfiable',
			contentRange: 'bytes */10',
		});

		const response = await harness.service.get(7, 'Build/game.wasm.br', { range });

		expect(response.status).toBe(416);
		expect(response.headers).toMatchObject({ 'Content-Range': 'bytes */10' });
		expect(response.body).toBeUndefined();
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		const expectedRange = range.endsWith('-')
			? { kind: 'open' as const, start: 9_007_199_254_740_992n }
			: {
				kind: 'closed' as const,
				start: 9_007_199_254_740_992n,
				end: 9_007_199_254_740_993n,
			};
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			range: expectedRange,
		});
	});

	it('falls back to one HEAD when a typed 416 lacks authoritative size metadata', async () => {
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce({ kind: 'range-not-satisfiable' });

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=10-',
		});

		expect(response).toMatchObject({
			status: 416,
			headers: { 'Content-Range': 'bytes */10' },
		});
		expect(response.body).toBeUndefined();
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.head).toHaveBeenCalledOnce();
	});

	it('rejects a ranged success missing Content-Range without adding a normal-path HEAD', async () => {
		const harness = serviceHarness();
		const body = new PassThrough();
		harness.stream.mockResolvedValueOnce(objectResult(body, { size: 4 }));

		await expect(harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
		})).rejects.toThrow(/Content-Range/i);
		expect(body.destroyed).toBe(true);
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.head).not.toHaveBeenCalled();
	});
});

describe('public WebGL conditional GET contract', () => {
	it('parses an opaque comma inside an entity-tag without splitting the tag', async () => {
		expect(normalizeIfNoneMatch('"x,y", W/"etag-1"')).toBe('"x,y", "etag-1"');
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce({ kind: 'not-modified', etag, lastModified });

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			ifNoneMatch: '"x,y", W/"etag-1"',
		});

		expect(response.status).toBe(304);
		expect(response.body).toBeUndefined();
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			ifNoneMatch: '"x,y", "etag-1"',
		});
	});

	it.each([
		['exact', '"etag-1"', '"etag-1"', '"etag-1"'],
		['weak', 'W/"etag-1"', '"etag-1"', '"etag-1"'],
		['list', 'W/"other", "etag-1"', '"other", "etag-1"', undefined],
		['wildcard', '*', '*', undefined],
	] as const)('returns a bodyless 304 for a matching %s If-None-Match', async (
		_label,
		ifNoneMatch,
		expectedValidator,
		expectedFallback,
	) => {
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce({ kind: 'not-modified', etag, lastModified });

		const response = await harness.service.get(7, 'Build/game.wasm.br', { ifNoneMatch });

		expect(response).toMatchObject({
			status: 304,
			headers: {
				'Cache-Control': 'public, max-age=300, must-revalidate',
				ETag: etag,
				'Last-Modified': 'Wed, 12 Aug 2026 01:02:03 GMT',
			},
		});
		expect(response.body).toBeUndefined();
		expect(response.headers).not.toHaveProperty('Content-Length');
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			ifNoneMatch: expectedValidator,
			...(expectedFallback ? { notModifiedEtagFallback: expectedFallback } : {}),
		});
	});

	it.each([
		[
			'list If-None-Match',
			{ ifNoneMatch: 'W/"other", "etag-1"' },
			{ ifNoneMatch: '"other", "etag-1"' },
		],
		['wildcard If-None-Match', { ifNoneMatch: '*' }, { ifNoneMatch: '*' }],
		[
			'If-Modified-Since',
			{ ifModifiedSince: 'Wed, 12 Aug 2026 01:02:03 GMT' },
			{ ifModifiedSince: lastModified },
		],
	] satisfies ReadonlyArray<readonly [string, PublicWebglRequestHeaders, ObjectStreamRequest]>)('fills a headerless storage 304 with current metadata for %s', async (
		_label,
		headers,
		expectedRequest,
	) => {
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce({ kind: 'not-modified' });

		const response = await harness.service.get(7, 'Build/game.wasm.br', headers);

		expect(response).toMatchObject({
			status: 304,
			headers: {
				ETag: etag,
				'Last-Modified': 'Wed, 12 Aug 2026 01:02:03 GMT',
			},
		});
		expect(response.body).toBeUndefined();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith(
			'public',
			storageKey,
			expectedRequest,
		);
		expect(harness.head).toHaveBeenCalledOnce();
	});

	it('converges a continuously headerless stale conditional 304 to one unconditional GET', async () => {
		const harness = serviceHarness();
		const currentBody = new PassThrough();
		const currentLastModified = new Date('2026-08-12T01:03:04.000Z');
		harness.stream.mockImplementation(async (_bucket, _key, request) => (
			request
				? { kind: 'not-modified' }
				: objectResult(currentBody, {
				etag: '"etag-2"',
				lastModified: currentLastModified,
			})
		));
		harness.head.mockResolvedValueOnce({
			size: content.byteLength,
			contentType: 'application/wasm',
			etag: '"etag-2"',
			lastModified: currentLastModified,
		});

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			ifNoneMatch: '"other", "etag-1"',
		});

		expect(response).toMatchObject({
			status: 200,
			headers: {
				ETag: '"etag-2"',
				'Last-Modified': 'Wed, 12 Aug 2026 01:03:04 GMT',
			},
			body: currentBody,
		});
		expect(currentBody.destroyed).toBe(false);
		expect(harness.head).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledTimes(2);
		expect(harness.stream).toHaveBeenNthCalledWith(1, 'public', storageKey, {
			ifNoneMatch: '"other", "etag-1"',
		});
		expect(harness.stream).toHaveBeenNthCalledWith(2, 'public', storageKey, undefined);
		currentBody.destroy();
	});

	it('locally returns 304 and destroys the unconditional body after an ETag ABA change', async () => {
		const harness = serviceHarness();
		const abaBody = new PassThrough();
		harness.stream
			.mockResolvedValueOnce({ kind: 'not-modified' })
			.mockResolvedValueOnce(objectResult(abaBody));
		harness.head.mockResolvedValueOnce({
			size: content.byteLength,
			contentType: 'application/wasm',
			etag: '"etag-2"',
			lastModified: new Date('2026-08-12T01:03:04.000Z'),
		});

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			ifNoneMatch: '"other", "etag-1"',
		});

		expect(response).toMatchObject({
			status: 304,
			headers: {
				ETag: etag,
				'Last-Modified': 'Wed, 12 Aug 2026 01:02:03 GMT',
			},
		});
		expect(response.body).toBeUndefined();
		expect(abaBody.destroyed).toBe(true);
		expect(harness.head).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledTimes(2);
		expect(harness.stream).toHaveBeenNthCalledWith(2, 'public', storageKey, undefined);
	});

	it('locally returns 304 and destroys the unconditional body after an IMS ABA change', async () => {
		const harness = serviceHarness();
		const abaBody = new PassThrough();
		const abaLastModified = new Date('2026-08-12T01:02:02.000Z');
		harness.stream
			.mockResolvedValueOnce({ kind: 'not-modified' })
			.mockResolvedValueOnce(objectResult(abaBody, {
				etag: '"etag-3"',
				lastModified: abaLastModified,
			}));
		harness.head.mockResolvedValueOnce({
			size: content.byteLength,
			contentType: 'application/wasm',
			etag: '"etag-2"',
			lastModified: new Date('2026-08-12T01:03:04.000Z'),
		});

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			ifModifiedSince: 'Wed, 12 Aug 2026 01:02:03 GMT',
		});

		expect(response).toMatchObject({
			status: 304,
			headers: {
				ETag: '"etag-3"',
				'Last-Modified': 'Wed, 12 Aug 2026 01:02:02 GMT',
			},
		});
		expect(response.body).toBeUndefined();
		expect(abaBody.destroyed).toBe(true);
		expect(harness.head).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledTimes(2);
		expect(harness.stream).toHaveBeenNthCalledWith(2, 'public', storageKey, undefined);
	});

	it('streams an If-None-Match miss through the same single conditional GET', async () => {
		const harness = serviceHarness();
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			ifNoneMatch: '"different"',
		});

		expect(response.status).toBe(200);
		expect(response.body).toBeInstanceOf(Readable);
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			ifNoneMatch: '"different"',
			notModifiedEtagFallback: '"different"',
		});
	});

	it('ignores a malformed If-None-Match atomically and suppresses If-Modified-Since', async () => {
		const harness = serviceHarness();
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			ifNoneMatch: '"etag-1", invalid',
			ifModifiedSince: 'Wed, 12 Aug 2099 01:02:03 GMT',
		});

		expect(response.status).toBe(200);
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, undefined);
	});

	it.each([
		'"etag-1", "unterminated',
		'"etag-1", invalid',
		'"etag-1" trailing',
	])('ignores the entire malformed tag list and suppresses IMS: %s', async (ifNoneMatch) => {
		expect(normalizeIfNoneMatch(ifNoneMatch)).toBeUndefined();
		const harness = serviceHarness();
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			ifNoneMatch,
			ifModifiedSince: 'Wed, 12 Aug 2099 01:02:03 GMT',
		});
		expect(response.status).toBe(200);
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, undefined);
	});

	it.each([
		['hit', 'Wed, 12 Aug 2026 01:02:03 GMT', 304],
		['miss', 'Wed, 12 Aug 2026 00:02:03 GMT', 200],
	] as const)('handles an If-Modified-Since %s with one conditional GET', async (
		_label,
		ifModifiedSince,
		expectedStatus,
	) => {
		const harness = serviceHarness();
		if (expectedStatus === 304) {
			harness.stream.mockResolvedValueOnce({ kind: 'not-modified', etag, lastModified });
		}
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			ifModifiedSince,
		});
		expect(response.status).toBe(expectedStatus);
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			ifModifiedSince: new Date(ifModifiedSince),
		});
		if (expectedStatus === 304) expect(response.body).toBeUndefined();
	});

	it('ignores an invalid If-Modified-Since value', async () => {
		const harness = serviceHarness();
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			ifModifiedSince: 'not-a-date',
		});
		expect(response.status).toBe(200);
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, undefined);
	});

	it.each([
		'Wed, 31 Feb 2026 01:02:03 GMT',
		'Thu, 12 Aug 2026 01:02:03 GMT',
		'Wed, 12 Aug 2026 25:61:61 GMT',
	])('strictly ignores an invalid HTTP-date IMS without a metadata lookup: %s', async (
		ifModifiedSince,
	) => {
		const harness = serviceHarness();
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			ifModifiedSince,
		});

		expect(response.status).toBe(200);
		expect(response.body).toBeInstanceOf(Readable);
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, undefined);
	});

	it('gives a present nonmatching If-None-Match precedence over If-Modified-Since', async () => {
		const harness = serviceHarness();
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			ifNoneMatch: '"different"',
			ifModifiedSince: 'Wed, 12 Aug 2099 01:02:03 GMT',
		});
		expect(response.status).toBe(200);
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			ifNoneMatch: '"different"',
			notModifiedEtagFallback: '"different"',
		});
	});

	it.each([
		['hit', { kind: 'not-modified', etag, lastModified } as const, 304],
		['miss', objectResult(Readable.from([Buffer.from('2345')]), {
			size: 4,
			contentRange: 'bytes 2-5/10',
		}), 206],
	] as const)('applies an ordinary validator before range processing on a %s', async (
		_label,
		outcome,
		expectedStatus,
	) => {
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce(outcome);
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifNoneMatch: '"etag-1"',
		});
		expect(response.status).toBe(expectedStatus);
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			range: { kind: 'closed', start: 2n, end: 5n },
			ifNoneMatch: '"etag-1"',
			notModifiedEtagFallback: '"etag-1"',
		});
		if (expectedStatus === 304) expect(response.body).toBeUndefined();
	});
});

describe('public WebGL If-Range and HEAD contract', () => {
	it('keeps matching If-None-Match authoritative at HEAD for a matching strong ETag If-Range', async () => {
		const harness = serviceHarness();

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifNoneMatch: etag,
			ifRange: etag,
		});

		expect(response.status).toBe(304);
		expect(response.body).toBeUndefined();
		expect(response.headers).not.toHaveProperty('Content-Length');
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).toHaveBeenCalledOnce();
		expect(harness.stream).not.toHaveBeenCalled();
	});

	it('keeps a matching ordinary precondition authoritative after date If-Range mismatch', async () => {
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce({ kind: 'not-modified', etag, lastModified });

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifNoneMatch: '"etag-1"',
			ifRange: 'Wed, 12 Aug 2026 01:02:03 GMT',
		});

		expect(response.status).toBe(304);
		expect(response.body).toBeUndefined();
		expect(response.headers).not.toHaveProperty('Content-Length');
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			ifNoneMatch: '"etag-1"',
			notModifiedEtagFallback: '"etag-1"',
		});
	});

	it('uses one full conditional GET after nonmatching INM and date If-Range mismatch', async () => {
		const harness = serviceHarness();
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifNoneMatch: '"ordinary-miss"',
			ifRange: 'Wed, 12 Aug 2026 01:02:03 GMT',
		});

		expect(response.status).toBe(200);
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			ifNoneMatch: '"ordinary-miss"',
			notModifiedEtagFallback: '"ordinary-miss"',
		});
	});

	it('preserves If-Modified-Since on a full GET after date If-Range mismatch', async () => {
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce({ kind: 'not-modified', etag, lastModified });

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifModifiedSince: 'Wed, 12 Aug 2026 01:02:03 GMT',
			ifRange: 'Wed, 12 Aug 2026 01:02:03 GMT',
		});

		expect(response.status).toBe(304);
		expect(response.body).toBeUndefined();
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			ifModifiedSince: lastModified,
		});
	});

	it('uses one conditional range GET after nonmatching INM and matching strong ETag If-Range', async () => {
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce(objectResult(
			Readable.from([Buffer.from('2345')]),
			{ size: 4, contentRange: 'bytes 2-5/10' },
		));
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifNoneMatch: '"ordinary-miss"',
			ifRange: etag,
		});

		expect(response.status).toBe(206);
		expect(response.headers).toMatchObject({ 'Content-Range': 'bytes 2-5/10' });
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			range: { kind: 'closed', start: 2n, end: 5n },
			ifNoneMatch: '"ordinary-miss"',
			notModifiedEtagFallback: '"ordinary-miss"',
			ifMatch: etag,
		});
	});

	it.each([
		['weak ETag', 'W/"etag-1"'],
		['invalid value', 'not-a-validator'],
	] as const)('ignores a %s If-Range and uses one full ordinary conditional GET', async (
		_label,
		ifRange,
	) => {
		const harness = serviceHarness();
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifNoneMatch: '"ordinary-miss"',
			ifRange,
		});

		expect(response.status).toBe(200);
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			ifNoneMatch: '"ordinary-miss"',
			notModifiedEtagFallback: '"ordinary-miss"',
		});
	});

	it('uses HEAD then one range GET for a matching strong ETag If-Range', async () => {
		const harness = serviceHarness();
		harness.stream.mockResolvedValueOnce(objectResult(
			Readable.from([Buffer.from('2345')]),
			{ size: 4, contentRange: 'bytes 2-5/10' },
		));
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifRange: etag,
		});
		expect(response.status).toBe(206);
		expect(harness.head).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, {
			range: { kind: 'closed', start: 2n, end: 5n },
			ifMatch: etag,
		});
	});

	it.each([
		['IMF-fixdate', 'Wed, 12 Aug 2026 01:02:03 GMT'],
		['RFC 850 date', 'Wednesday, 12-Aug-26 01:02:03 GMT'],
		['asctime date', 'Wed Aug 12 01:02:03 2026'],
	] as const)('treats an exact %s If-Range date as a mismatch and serves the full body', async (
		_label,
		ifRange,
	) => {
		const harness = serviceHarness();

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifRange,
		});

		expect(response.status).toBe(200);
		expect(response.headers).not.toHaveProperty('Content-Range');
		await expect(bodyBuffer(response.body)).resolves.toEqual(content);
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, undefined);
	});

	it('abandons a range when HEAD cannot identify a representation to pin', async () => {
		const harness = serviceHarness();
		harness.head.mockResolvedValueOnce({
			size: content.byteLength,
			contentType: 'application/wasm',
		});

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifRange: etag,
		});

		expect(response.status).toBe(200);
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.head).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, undefined);
	});

	it('retries a full GET when the object changes after a matching If-Range HEAD', async () => {
		const harness = serviceHarness();
		const currentBody = new PassThrough();
		const currentLastModified = new Date('2026-08-12T01:03:04.000Z');
		harness.stream
			.mockResolvedValueOnce({ kind: 'precondition-failed' })
			.mockResolvedValueOnce(objectResult(currentBody, {
				etag: '"etag-2"',
				lastModified: currentLastModified,
			}));

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifRange: etag,
		});

		expect(response).toMatchObject({ status: 200, body: currentBody });
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(currentBody.destroyed).toBe(false);
		expect(harness.head).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledTimes(2);
		expect(harness.stream).toHaveBeenNthCalledWith(1, 'public', storageKey, {
			range: { kind: 'closed', start: 2n, end: 5n },
			ifMatch: etag,
		});
		expect(harness.stream).toHaveBeenNthCalledWith(2, 'public', storageKey, undefined);
		currentBody.destroy();
	});

	it('keeps ordinary validators when an If-Range pin fails and can return current 304', async () => {
		const harness = serviceHarness();
		harness.stream
			.mockResolvedValueOnce({ kind: 'precondition-failed' })
			.mockResolvedValueOnce({
				kind: 'not-modified',
				etag: '"etag-2"',
				lastModified: new Date('2026-08-12T01:03:04.000Z'),
			});

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifNoneMatch: '"etag-2"',
			ifRange: etag,
		});

		expect(response).toMatchObject({
			status: 304,
			headers: { ETag: '"etag-2"' },
		});
		expect(response.body).toBeUndefined();
		expect(harness.stream).toHaveBeenCalledTimes(2);
		expect(harness.stream).toHaveBeenNthCalledWith(1, 'public', storageKey, {
			range: { kind: 'closed', start: 2n, end: 5n },
			ifNoneMatch: '"etag-2"',
			notModifiedEtagFallback: '"etag-2"',
			ifMatch: etag,
		});
		expect(harness.stream).toHaveBeenNthCalledWith(2, 'public', storageKey, {
			ifNoneMatch: '"etag-2"',
			notModifiedEtagFallback: '"etag-2"',
		});
	});

	it('converges a 412 then stale headerless conditional 304 to one unconditional GET', async () => {
		const harness = serviceHarness();
		const currentBody = new PassThrough();
		const currentLastModified = new Date('2026-08-12T01:04:05.000Z');
		harness.stream
			.mockResolvedValueOnce({ kind: 'precondition-failed' })
			.mockResolvedValueOnce({ kind: 'not-modified' })
			.mockResolvedValueOnce(objectResult(currentBody, {
				etag: '"etag-3"',
				lastModified: currentLastModified,
			}));
		harness.head
			.mockResolvedValueOnce({
				size: content.byteLength,
				contentType: 'application/wasm',
				etag,
				lastModified,
			})
			.mockResolvedValueOnce({
				size: content.byteLength,
				contentType: 'application/wasm',
				etag: '"etag-3"',
				lastModified: currentLastModified,
			});

		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifNoneMatch: '"etag-2"',
			ifRange: etag,
		});

		expect(response).toMatchObject({ status: 200, body: currentBody });
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.head).toHaveBeenCalledTimes(2);
		expect(harness.stream).toHaveBeenCalledTimes(3);
		expect(harness.stream).toHaveBeenNthCalledWith(1, 'public', storageKey, {
			range: { kind: 'closed', start: 2n, end: 5n },
			ifNoneMatch: '"etag-2"',
			notModifiedEtagFallback: '"etag-2"',
			ifMatch: etag,
		});
		expect(harness.stream).toHaveBeenNthCalledWith(2, 'public', storageKey, {
			ifNoneMatch: '"etag-2"',
			notModifiedEtagFallback: '"etag-2"',
		});
		expect(harness.stream).toHaveBeenNthCalledWith(3, 'public', storageKey, undefined);
		currentBody.destroy();
	});

	it('falls back to one full GET after a mismatching strong ETag If-Range', async () => {
		const harness = serviceHarness();
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifRange: '"different"',
		});
		expect(response.status).toBe(200);
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.head).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, undefined);
	});

	it.each([
		'Wed, 31 Feb 2026 01:02:03 GMT',
		'Thu, 12 Aug 2026 01:02:03 GMT',
		'Wed, 12 Aug 2026 25:61:61 GMT',
	])('strictly treats an invalid HTTP-date If-Range as a full GET without HEAD: %s', async (
		ifRange,
	) => {
		const harness = serviceHarness();
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifRange,
		});

		expect(response.status).toBe(200);
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, undefined);
	});

	it.each([
		['weak ETag', 'W/"etag-1"'],
		['invalid value', 'not-a-validator'],
	] as const)('falls back directly to one full GET for a %s If-Range', async (
		_label,
		ifRange,
	) => {
		const harness = serviceHarness();
		const response = await harness.service.get(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifRange,
		});
		expect(response.status).toBe(200);
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.head).not.toHaveBeenCalled();
		expect(harness.stream).toHaveBeenCalledOnce();
		expect(harness.stream).toHaveBeenCalledWith('public', storageKey, undefined);
	});

	it('serves explicit HEAD metadata without opening a GET and ignores Range/If-Range', async () => {
		const harness = serviceHarness();
		const response = await harness.service.head(7, 'Build/game.wasm.br', {
			range: 'bytes=2-5',
			ifRange: etag,
		});
		expect(response).toMatchObject({
			status: 200,
			headers: {
				'Content-Length': '10',
				'Accept-Ranges': 'bytes',
				ETag: etag,
				'Last-Modified': 'Wed, 12 Aug 2026 01:02:03 GMT',
			},
		});
		expect(response.body).toBeUndefined();
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.findPublicWebglProject).toHaveBeenCalledOnce();
		expect(harness.head).toHaveBeenCalledOnce();
		expect(harness.stream).not.toHaveBeenCalled();
	});

	it.each([
		[{ ifNoneMatch: 'W/"other", W/"etag-1"' }, 'If-None-Match'],
		[{ ifModifiedSince: 'Wed, 12 Aug 2026 01:02:03 GMT' }, 'If-Modified-Since'],
	] as const)('returns bodyless HEAD 304 for matching %s', async (
		headers: PublicWebglRequestHeaders,
		_label,
	) => {
		const harness = serviceHarness();
		const response = await harness.service.head(7, 'Build/game.wasm.br', headers);
		expect(response.status).toBe(304);
		expect(response.body).toBeUndefined();
		expect(response.headers).toMatchObject({
			'Cache-Control': 'public, max-age=300, must-revalidate',
			ETag: etag,
			'Last-Modified': 'Wed, 12 Aug 2026 01:02:03 GMT',
		});
		expect(response.headers).not.toHaveProperty('Content-Length');
		expect(response.headers).not.toHaveProperty('Content-Range');
		expect(harness.head).toHaveBeenCalledOnce();
		expect(harness.stream).not.toHaveBeenCalled();
	});
});
