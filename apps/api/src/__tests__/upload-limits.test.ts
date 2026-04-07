import { describe, it, expect, beforeEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
	kindLimit,
	fieldnameToKind,
	createByteLimiter,
	acquireUploadSlot,
	releaseUploadSlot,
	activeUploadCount,
	_resetActiveUploads,
	type UploadLimits,
} from '../shared/upload-limits.js';
import { AppError } from '../shared/errors.js';

// ── kindLimit (pure — no env dependency) ────────────────────

const fakeLimits: UploadLimits = {
	posterMaxBytes: 5 * 1024 * 1024,
	imageMaxBytes: 10 * 1024 * 1024,
	gameMaxBytes: 200 * 1024 * 1024,
	videoMaxBytes: 200 * 1024 * 1024,
	requestMaxBytes: 250 * 1024 * 1024,
	maxFiles: 10,
};

describe('kindLimit', () => {
	it('returns game limit for GAME kind', () => {
		expect(kindLimit(fakeLimits, 'GAME')).toBe(fakeLimits.gameMaxBytes);
	});

	it('returns poster limit for POSTER kind', () => {
		expect(kindLimit(fakeLimits, 'POSTER')).toBe(fakeLimits.posterMaxBytes);
	});

	it('returns poster limit for THUMBNAIL kind', () => {
		expect(kindLimit(fakeLimits, 'THUMBNAIL')).toBe(fakeLimits.posterMaxBytes);
	});

	it('returns image limit for IMAGE kind', () => {
		expect(kindLimit(fakeLimits, 'IMAGE')).toBe(fakeLimits.imageMaxBytes);
	});

	it('game > image > poster for typical config', () => {
		expect(fakeLimits.gameMaxBytes).toBeGreaterThan(fakeLimits.imageMaxBytes);
		expect(fakeLimits.imageMaxBytes).toBeGreaterThan(fakeLimits.posterMaxBytes);
	});
});

// ── fieldnameToKind ─────────────────────────────────────────

describe('fieldnameToKind', () => {
	it('maps poster → POSTER', () => {
		expect(fieldnameToKind('poster')).toBe('POSTER');
	});

	it('maps images[] → IMAGE', () => {
		expect(fieldnameToKind('images[]')).toBe('IMAGE');
	});

	it('maps gameFile → GAME', () => {
		expect(fieldnameToKind('gameFile')).toBe('GAME');
	});

	it('returns undefined for unknown field', () => {
		expect(fieldnameToKind('payload')).toBeUndefined();
		expect(fieldnameToKind('randomField')).toBeUndefined();
	});
});

// ── createByteLimiter ───────────────────────────────────────

describe('createByteLimiter', () => {
	it('passes data through when under limit', async () => {
		const limiter = createByteLimiter(100);
		const chunks: Buffer[] = [];
		const sink = new Writable({
			write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
		});
		const source = Readable.from([Buffer.alloc(50), Buffer.alloc(30)]);

		await pipeline(source, limiter, sink);
		const total = chunks.reduce((s, c) => s + c.length, 0);
		expect(total).toBe(80);
	});

	it('throws 413 when limit is exceeded', async () => {
		const limiter = createByteLimiter(100, 'testfile');

		const source = Readable.from([Buffer.alloc(60), Buffer.alloc(60)]);
		const sink = new Writable({
			write(_chunk, _enc, cb) { cb(); },
		});

		try {
			await pipeline(source, limiter, sink);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(413);
			expect((err as AppError).message).toContain('testfile');
		}
	});

	it('throws immediately on single chunk exceeding limit', async () => {
		const limiter = createByteLimiter(10);
		const source = Readable.from([Buffer.alloc(20)]);
		const sink = new Writable({
			write(_chunk, _enc, cb) { cb(); },
		});

		try {
			await pipeline(source, limiter, sink);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(413);
		}
	});

	it('includes MB in error message', async () => {
		const limiter = createByteLimiter(10 * 1024 * 1024, 'poster.jpg');
		const source = Readable.from([Buffer.alloc(11 * 1024 * 1024)]);
		const sink = new Writable({
			write(_chunk, _enc, cb) { cb(); },
		});

		try {
			await pipeline(source, limiter, sink);
			expect.fail('should have thrown');
		} catch (err) {
			expect((err as AppError).message).toContain('10MB');
			expect((err as AppError).message).toContain('poster.jpg');
		}
	});
});

// ── Concurrent upload semaphore (using explicit max) ────────

describe('upload concurrency', () => {
	beforeEach(() => {
		_resetActiveUploads();
	});

	it('tracks active upload count', () => {
		expect(activeUploadCount()).toBe(0);
		acquireUploadSlot(5);
		expect(activeUploadCount()).toBe(1);
		acquireUploadSlot(5);
		expect(activeUploadCount()).toBe(2);
		releaseUploadSlot();
		expect(activeUploadCount()).toBe(1);
		releaseUploadSlot();
		expect(activeUploadCount()).toBe(0);
	});

	it('does not go below zero on extra release', () => {
		releaseUploadSlot();
		expect(activeUploadCount()).toBe(0);
	});

	it('throws 429 when max concurrent uploads reached', () => {
		for (let i = 0; i < 3; i++) acquireUploadSlot(3);
		expect(activeUploadCount()).toBe(3);

		try {
			acquireUploadSlot(3);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(429);
			expect((err as AppError).message).toContain('3');
		}
	});

	it('allows new slot after release', () => {
		for (let i = 0; i < 3; i++) acquireUploadSlot(3);
		releaseUploadSlot();
		expect(() => acquireUploadSlot(3)).not.toThrow();
	});
});
