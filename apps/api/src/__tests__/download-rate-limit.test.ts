import { describe, it, expect, afterEach } from 'vitest';
import { DownloadRateLimiter } from '../shared/download-rate-limit.js';
import { AppError } from '../shared/errors.js';

describe('DownloadRateLimiter', () => {
	const limiters: DownloadRateLimiter[] = [];

	function create(opts?: ConstructorParameters<typeof DownloadRateLimiter>[0]) {
		const l = new DownloadRateLimiter(opts);
		limiters.push(l);
		return l;
	}

	afterEach(() => {
		for (const l of limiters) l.close();
		limiters.length = 0;
	});

	it('allows requests under the limit', () => {
		const limiter = create({ maxHits: 5, windowMs: 60_000 });
		for (let i = 0; i < 5; i++) {
			expect(limiter.check('1.2.3.4')).toEqual({ status: 'ok' });
		}
	});

	it('returns a retry hint without creating a durable or in-memory ban', () => {
		const limiter = create({ maxHits: 3, windowMs: 60_000 });
		expect(limiter.check('1.2.3.4')).toEqual({ status: 'ok' });
		expect(limiter.check('1.2.3.4')).toEqual({ status: 'ok' });
		expect(limiter.check('1.2.3.4')).toEqual({ status: 'ok' });

		// The fourth request is throttled only for the remaining window.
		expect(limiter.check('1.2.3.4')).toEqual({ status: 'rate_limited', retryAfterSec: 60 });
		expect(limiter.isBanned('1.2.3.4')).toBe(false);
	});

	it('throws 403 for already-banned IPs', () => {
		const limiter = create({ maxHits: 10, windowMs: 60_000 });
		limiter.addBan('9.9.9.9');

		try {
			limiter.check('9.9.9.9');
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
			expect((err as AppError).code).toBe('IP_BANNED');
		}
	});

	it('tracks IPs independently', () => {
		const limiter = create({ maxHits: 2, windowMs: 60_000 });
		limiter.check('1.1.1.1');
		limiter.check('1.1.1.1');

		// 1.1.1.1 is at limit, but 2.2.2.2 should be fine
		expect(limiter.check('2.2.2.2')).toEqual({ status: 'ok' });
		expect(limiter.check('1.1.1.1')).toMatchObject({ status: 'rate_limited' });
	});

	it('keeps excess traffic transient and recovers after cooldown', () => {
		let now = new Date('2026-07-21T00:00:00.000Z');
		const limiter = create({ maxHits: 1, windowMs: 60_000, clock: { now: () => now } });
		limiter.check('1.2.3.4');  // ok

		expect(limiter.check('1.2.3.4')).toMatchObject({ status: 'rate_limited' });
		expect(limiter.isBanned('1.2.3.4')).toBe(false);
		now = new Date('2026-07-21T00:01:00.001Z');
		expect(limiter.check('1.2.3.4')).toEqual({ status: 'ok' });
	});

	it('removeBan allows IP to download again', () => {
		const limiter = create({ maxHits: 10, windowMs: 60_000 });
		limiter.addBan('1.2.3.4');
		expect(limiter.isBanned('1.2.3.4')).toBe(true);

		limiter.removeBan('1.2.3.4');
		expect(limiter.isBanned('1.2.3.4')).toBe(false);
		expect(limiter.check('1.2.3.4')).toEqual({ status: 'ok' });
	});

	it('loadBannedIps populates cache', () => {
		const limiter = create({ maxHits: 10, windowMs: 60_000 });
		limiter.loadBannedIps(['10.0.0.1', '10.0.0.2']);
		expect(limiter._bannedSize()).toBe(2);
		expect(limiter.isBanned('10.0.0.1')).toBe(true);
		expect(limiter.isBanned('10.0.0.2')).toBe(true);
		expect(limiter.isBanned('10.0.0.3')).toBe(false);
	});

	it('resets after window expires', () => {
		let now = new Date('2026-07-21T00:00:00.000Z');
		const limiter = create({
			maxHits: 1,
			windowMs: 1_000,
			clock: { now: () => now },
		});
		limiter.check('1.2.3.4');

		now = new Date('2026-07-21T00:00:01.001Z');

		expect(limiter.check('1.2.3.4')).toEqual({ status: 'ok' });
	});

	it('checks a manual denylist before any transient scoped bucket', () => {
		const limiter = create({ maxHits: 1, windowMs: 60_000 });
		limiter.loadBannedIps(['203.0.113.8']);
		expect(() => limiter.check('203.0.113.8', 'actor:download:asset')).toThrowError(
			expect.objectContaining({ statusCode: 403, code: 'IP_BANNED' }),
		);
		expect(limiter._bucketSize()).toBe(0);
	});

	it('scopes transient limits by actor, action, and asset under a shared IP', () => {
		const limiter = create({ maxHits: 1, windowMs: 60_000 });
		expect(limiter.check('203.0.113.9', '1:DOWNLOAD_ORIGINAL:10')).toEqual({ status: 'ok' });
		expect(limiter.check('203.0.113.9', '2:DOWNLOAD_ORIGINAL:10')).toEqual({ status: 'ok' });
		expect(limiter.check('203.0.113.9', '1:DOWNLOAD_ORIGINAL:11')).toEqual({ status: 'ok' });
	});

	it('cleans up on close', () => {
		const limiter = create({ maxHits: 10, windowMs: 60_000 });
		limiter.check('1.2.3.4');
		limiter.addBan('5.6.7.8');
		expect(limiter._bucketSize()).toBe(1);
		expect(limiter._bannedSize()).toBe(1);

		limiter.close();
		expect(limiter._bucketSize()).toBe(0);
		expect(limiter._bannedSize()).toBe(0);
	});
});
