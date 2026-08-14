import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createObjectStorage } from '../lib/storage.js';

describe('object storage HEAD metadata', () => {
	it('exposes validators and cache metadata without opening a body', async () => {
		const lastModified = new Date('2026-08-12T00:00:00.000Z');
		const send = vi.fn(async (..._args: unknown[]) => ({
			ContentLength: 123,
			ContentType: 'image/webp',
			CacheControl: 'public, max-age=31536000, immutable',
			ETag: '"abc"',
			LastModified: lastModified,
		}));
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await expect(storage.head('public', 'image.webp')).resolves.toEqual({
			size: 123,
			contentType: 'image/webp',
			cacheControl: 'public, max-age=31536000, immutable',
			etag: '"abc"',
			lastModified,
		});
		expect(send).toHaveBeenCalledOnce();
	});

	it('returns null only for object-not-found and propagates storage failures', async () => {
		const send = vi.fn()
			.mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
			.mockRejectedValueOnce(new Error('storage unavailable'));
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await expect(storage.head('public', 'missing.webp')).resolves.toBeNull();
		await expect(storage.head('public', 'failed.webp')).rejects.toThrow('storage unavailable');
	});
});

describe('object storage streamed GET contract', () => {
	it('treats an empty options object as an unconditional GetObject request', async () => {
		const send = vi.fn(async (..._args: unknown[]) => ({
			Body: new PassThrough(),
			ContentLength: 0,
		}));
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await storage.stream('public', 'game.data', {});

		expect(send).toHaveBeenCalledOnce();
		const command = send.mock.calls[0]![0] as GetObjectCommand;
		expect(command).toBeInstanceOf(GetObjectCommand);
		expect(command.input).toEqual({ Bucket: 'public', Key: 'game.data' });
		expect(command.input).not.toHaveProperty('Range');
		expect(command.input).not.toHaveProperty('IfNoneMatch');
		expect(command.input).not.toHaveProperty('IfModifiedSince');
	});

	it.each([
		['closed', { range: { kind: 'closed', start: 2n, end: 5n } }, 'bytes=2-5'],
		['open-ended', { range: { kind: 'open', start: 4n } }, 'bytes=4-'],
		['suffix', { range: { kind: 'suffix', length: 3n } }, 'bytes=-3'],
		[
			'arbitrary-precision open-ended',
			{ range: { kind: 'open', start: 9_007_199_254_740_992n } },
			'bytes=9007199254740992-',
		],
	] as const)('serializes a %s byte range exactly once', async (
		_label,
		range,
		expectedHeader,
	) => {
		const send = vi.fn(async (..._args: unknown[]) => ({
			Body: new PassThrough(),
			ContentLength: 4,
			ContentRange: 'bytes 2-5/10',
		}));
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await storage.stream('public', 'game.data', range);

		expect(send).toHaveBeenCalledOnce();
		const command = send.mock.calls[0]![0] as GetObjectCommand;
		expect(command).toBeInstanceOf(GetObjectCommand);
		expect(command.input).toEqual({
			Bucket: 'public',
			Key: 'game.data',
			Range: expectedHeader,
		});
		expect(command).not.toBeInstanceOf(HeadObjectCommand);
	});

	it('uses one GetObject command for native ranges and validators and preserves response metadata', async () => {
		const body = new PassThrough();
		const lastModified = new Date('2026-08-12T01:02:03.000Z');
		const ifModifiedSince = new Date('2026-08-12T00:00:00.000Z');
		const send = vi.fn(async (..._args: unknown[]) => ({
			Body: body,
			ContentLength: 4,
			ContentType: 'application/wasm',
			ContentEncoding: 'br',
			CacheControl: 'storage-policy',
			ContentRange: 'bytes 2-5/10',
			ETag: '"etag-1"',
			LastModified: lastModified,
		}));
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		const result = await storage.stream('public', 'game.wasm.br', {
			range: { kind: 'closed', start: 2n, end: 5n },
			ifNoneMatch: 'W/"old", "etag-1"',
			ifModifiedSince,
		});

		expect(result).toEqual({
			body,
			size: 4,
			contentType: 'application/wasm',
			contentEncoding: 'br',
			cacheControl: 'storage-policy',
			contentRange: 'bytes 2-5/10',
			etag: '"etag-1"',
			lastModified,
		});
		expect(send).toHaveBeenCalledOnce();
		const command = send.mock.calls[0]![0] as GetObjectCommand;
		expect(command).toBeInstanceOf(GetObjectCommand);
		expect(command).not.toBeInstanceOf(HeadObjectCommand);
		expect(command.input).toEqual({
			Bucket: 'public',
			Key: 'game.wasm.br',
			Range: 'bytes=2-5',
			IfNoneMatch: 'W/"old", "etag-1"',
			IfModifiedSince: ifModifiedSince,
		});
	});

	it.each([
		['IfMatch', { ifMatch: '"etag-1"' }, { IfMatch: '"etag-1"' }],
		[
			'IfUnmodifiedSince',
			{ ifUnmodifiedSince: new Date('2026-08-12T01:02:03.000Z') },
			{ IfUnmodifiedSince: new Date('2026-08-12T01:02:03.000Z') },
		],
	] as const)('serializes the internal %s representation pin', async (
		_label,
		pin,
		expected,
	) => {
		const send = vi.fn(async (..._args: unknown[]) => ({
			Body: new PassThrough(),
			ContentLength: 4,
			ContentRange: 'bytes 2-5/10',
		}));
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await storage.stream('public', 'game.data', {
			range: { kind: 'closed', start: 2n, end: 5n },
			...pin,
		});

		const command = send.mock.calls[0]![0] as GetObjectCommand;
		expect(command.input).toEqual({
			Bucket: 'public',
			Key: 'game.data',
			Range: 'bytes=2-5',
			...expected,
		});
	});

	it('maps S3 304 to a bodyless typed outcome without a second object request', async () => {
		const send = vi.fn(async (..._args: unknown[]) => {
			throw {
				name: 'NotModified',
				$metadata: { httpStatusCode: 304 },
				$response: { headers: {
					etag: '"etag-1"',
					'last-modified': 'Wed, 12 Aug 2026 01:02:03 GMT',
				} },
			};
		});
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await expect(storage.stream('public', 'game.data', {
			ifNoneMatch: '"etag-1"',
		})).resolves.toEqual({
			kind: 'not-modified',
			etag: '"etag-1"',
			lastModified: new Date('2026-08-12T01:02:03.000Z'),
		});
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]![0]).toBeInstanceOf(GetObjectCommand);
	});

	it('restores the normalized single-tag ETag when a 304 error has no response headers', async () => {
		const send = vi.fn(async (..._args: unknown[]) => {
			throw { name: 'NotModified', $metadata: { httpStatusCode: 304 } };
		});
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await expect(storage.stream('public', 'game.data', {
			ifNoneMatch: '"etag-1"',
			notModifiedEtagFallback: '"etag-1"',
		})).resolves.toEqual({
			kind: 'not-modified',
			etag: '"etag-1"',
		});
		expect(send).toHaveBeenCalledOnce();
		const command = send.mock.calls[0]![0] as GetObjectCommand;
		expect(command).toBeInstanceOf(GetObjectCommand);
		expect(command.input).toEqual({
			Bucket: 'public',
			Key: 'game.data',
			IfNoneMatch: '"etag-1"',
		});
	});

	it('prefers an authoritative 304 response ETag over the request fallback', async () => {
		const send = vi.fn(async (..._args: unknown[]) => {
			throw {
				name: 'NotModified',
				$metadata: { httpStatusCode: 304 },
				$response: { headers: { etag: '"authoritative"' } },
			};
		});
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await expect(storage.stream('public', 'game.data', {
			ifNoneMatch: '"fallback"',
			notModifiedEtagFallback: '"fallback"',
		})).resolves.toEqual({
			kind: 'not-modified',
			etag: '"authoritative"',
		});
		expect(send).toHaveBeenCalledOnce();
	});

	it('normalizes a same-second IMS 200 response to a bodyless 304 outcome', async () => {
		const body = new PassThrough();
		const lastModified = new Date('2026-08-12T01:02:03.456Z');
		const ifModifiedSince = new Date('2026-08-12T01:02:03.000Z');
		const send = vi.fn(async (..._args: unknown[]) => ({
			Body: body,
			ContentLength: 10,
			ETag: '"etag-1"',
			LastModified: lastModified,
		}));
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await expect(storage.stream('public', 'game.data', {
			ifModifiedSince,
		})).resolves.toEqual({
			kind: 'not-modified',
			etag: '"etag-1"',
			lastModified,
		});
		expect(body.destroyed).toBe(true);
		expect(send).toHaveBeenCalledOnce();
	});

	it.each([
		['full GET', undefined, undefined, 10],
		[
			'Range GET',
			{ kind: 'closed', start: 2n, end: 5n } as const,
			'bytes=2-5',
			4,
		],
	] as const)(
		'keeps a successful %s stream when nonmatching INM takes precedence over same-second IMS',
		async (_label, range, rangeHeader, size) => {
			const body = new PassThrough();
			const lastModified = new Date('2026-08-12T01:02:03.456Z');
			const ifModifiedSince = new Date('2026-08-12T01:02:03.000Z');
			const send = vi.fn(async (..._args: unknown[]) => ({
				Body: body,
				ContentLength: size,
				...(rangeHeader ? { ContentRange: 'bytes 2-5/10' } : {}),
				ETag: '"etag-1"',
				LastModified: lastModified,
			}));
			const storage = createObjectStorage({ send } as unknown as S3Client, {
				defaultPresignTtlSec: 60,
			});

			const result = await storage.stream('public', 'game.data', {
				...(range ? { range } : {}),
				ifNoneMatch: '"different"',
				ifModifiedSince,
			});

			if (!result || 'kind' in result) {
				throw new Error('successful conditional GET was incorrectly converted to a typed outcome');
			}
			expect(result.body).toBe(body);
			expect(result).toMatchObject({
				size,
				etag: '"etag-1"',
				lastModified,
				...(rangeHeader ? { contentRange: 'bytes 2-5/10' } : {}),
			});
			expect(body.destroyed).toBe(false);
			expect(send).toHaveBeenCalledOnce();
			const command = send.mock.calls[0]![0] as GetObjectCommand;
			expect(command).toBeInstanceOf(GetObjectCommand);
			expect(command.input).toEqual({
				Bucket: 'public',
				Key: 'game.data',
				...(rangeHeader ? { Range: rangeHeader } : {}),
				IfNoneMatch: '"different"',
				IfModifiedSince: ifModifiedSince,
			});
		},
	);

	it('keeps the original stream when an IMS 200 response is modified', async () => {
		const body = new PassThrough();
		const lastModified = new Date('2026-08-12T01:02:04.000Z');
		const ifModifiedSince = new Date('2026-08-12T01:02:03.000Z');
		const send = vi.fn(async (..._args: unknown[]) => ({
			Body: body,
			ContentLength: 10,
			ETag: '"etag-1"',
			LastModified: lastModified,
		}));
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		const result = await storage.stream('public', 'game.data', { ifModifiedSince });

		expect(result).toMatchObject({
			body,
			size: 10,
			etag: '"etag-1"',
			lastModified,
		});
		expect(body.destroyed).toBe(false);
		expect(send).toHaveBeenCalledOnce();
	});

	it('maps S3 412 to a bodyless typed representation-pin outcome', async () => {
		const send = vi.fn(async (..._args: unknown[]) => {
			throw {
				name: 'PreconditionFailed',
				$metadata: { httpStatusCode: 412 },
				$response: { headers: {
					etag: '"etag-2"',
					'last-modified': 'Wed, 12 Aug 2026 01:03:04 GMT',
				} },
			};
		});
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await expect(storage.stream('public', 'game.data', {
			range: { kind: 'closed', start: 2n, end: 5n },
			ifMatch: '"etag-1"',
		})).resolves.toEqual({
			kind: 'precondition-failed',
			etag: '"etag-2"',
			lastModified: new Date('2026-08-12T01:03:04.000Z'),
		});
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]![0]).toBeInstanceOf(GetObjectCommand);
	});

	it('maps S3 416 to a typed outcome with the authoritative object size', async () => {
		const send = vi.fn(async (..._args: unknown[]) => {
			throw {
				name: 'InvalidRange',
				$metadata: { httpStatusCode: 416 },
				$response: { headers: {
					'content-range': 'bytes */10',
					etag: '"etag-1"',
					'last-modified': 'Wed, 12 Aug 2026 01:02:03 GMT',
				} },
			};
		});
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await expect(storage.stream('public', 'game.data', {
			range: { kind: 'open', start: 10n },
		})).resolves.toEqual({
			kind: 'range-not-satisfiable',
			size: 10,
			contentRange: 'bytes */10',
			etag: '"etag-1"',
			lastModified: new Date('2026-08-12T01:02:03.000Z'),
		});
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]![0]).toBeInstanceOf(GetObjectCommand);
	});

	it('maps only object-not-found to null and propagates unrelated GET failures', async () => {
		const send = vi.fn(async (..._args: unknown[]) => undefined)
			.mockRejectedValueOnce({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })
			.mockRejectedValueOnce(new Error('storage unavailable'));
		const storage = createObjectStorage({ send } as unknown as S3Client, {
			defaultPresignTtlSec: 60,
		});

		await expect(storage.stream('public', 'missing.data', {})).resolves.toBeNull();
		await expect(storage.stream('public', 'failed.data', {})).rejects.toThrow(
			'storage unavailable',
		);
		expect(send).toHaveBeenCalledTimes(2);
		for (const [command] of send.mock.calls) expect(command).toBeInstanceOf(GetObjectCommand);
	});
});
