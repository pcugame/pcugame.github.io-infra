import { afterEach, describe, expect, it } from 'vitest';
import { DownloadRateLimiter } from '../shared/download-rate-limit.js';
import { AppError } from '../shared/errors.js';

describe('DownloadRateLimiter', () => {
	const limiters: DownloadRateLimiter[] = [];
	const create = (options?: ConstructorParameters<typeof DownloadRateLimiter>[0]) => {
		const limiter = new DownloadRateLimiter(options);
		limiters.push(limiter);
		return limiter;
	};
	afterEach(() => {
		for (const limiter of limiters) limiter.close();
		limiters.length = 0;
	});

	it('temporarily limits one principal without banning its shared IP', () => {
		const limiter = create({ maxHits: 2, maxIpHits: 100, windowMs: 60_000 });
		expect(limiter.check('203.0.113.1', 'user:1:asset:42')).toEqual({ status: 'ok' });
		expect(limiter.check('203.0.113.1', 'user:1:asset:42')).toEqual({ status: 'ok' });
		expect(limiter.check('203.0.113.1', 'user:1:asset:42')).toEqual({
			status: 'rate_limited', retryAfterSec: 60,
		});
		expect(limiter.isBanned('203.0.113.1')).toBe(false);
	});

	it('allows 50 authenticated principals behind one NAT as independent primary scopes', () => {
		const limiter = create({ maxHits: 1, maxIpHits: 100, windowMs: 60_000 });
		for (let userId = 1; userId <= 50; userId += 1) {
			expect(limiter.check('203.0.113.2', `user:${userId}:asset:42`)).toEqual({ status: 'ok' });
		}
		expect(limiter._bucketSize()).toBe(50);
		expect(limiter._ipBucketSize()).toBe(1);
	});

	it('detects repeated single-actor abuse before the IP ceiling', () => {
		const limiter = create({ maxHits: 1, maxIpHits: 10, windowMs: 60_000 });
		expect(limiter.check('203.0.113.3', 'user:1:asset:42')).toEqual({ status: 'ok' });
		for (let attempt = 0; attempt < 4; attempt += 1) {
			expect(limiter.check('203.0.113.3', 'user:1:asset:42')).toMatchObject({
				status: 'rate_limited',
			});
		}
		expect(limiter.isBanned('203.0.113.3')).toBe(false);
	});

	it('signals and caches a ban only when the much higher IP abuse ceiling is crossed', () => {
		const limiter = create({ maxHits: 1, maxIpHits: 3, windowMs: 60_000 });
		expect(limiter.check('203.0.113.4', 'user:1')).toEqual({ status: 'ok' });
		expect(limiter.check('203.0.113.4', 'user:2')).toEqual({ status: 'ok' });
		expect(limiter.check('203.0.113.4', 'user:3')).toEqual({ status: 'ok' });
		expect(limiter.check('203.0.113.4', 'user:4')).toEqual({ status: 'abuse_ceiling' });
		expect(limiter.isBanned('203.0.113.4')).toBe(true);
		expect(() => limiter.check('203.0.113.4', 'user:5')).toThrowError(
			expect.objectContaining({ statusCode: 403, code: 'IP_BANNED' }),
		);
	});

	it('honors loaded manual bans before creating buckets', () => {
		const limiter = create();
		limiter.loadBannedIps(['198.51.100.1']);
		expect(() => limiter.check('198.51.100.1', 'user:1')).toThrow(AppError);
		expect(limiter._bucketSize()).toBe(0);
		expect(limiter._ipBucketSize()).toBe(0);
	});

	it('recovers principal capacity after the sliding window', () => {
		let now = new Date('2026-08-21T00:00:00.000Z');
		const limiter = create({
			maxHits: 1,
			maxIpHits: 10,
			windowMs: 1_000,
			clock: { now: () => now },
		});
		limiter.check('203.0.113.5', 'user:1');
		expect(limiter.check('203.0.113.5', 'user:1')).toMatchObject({ status: 'rate_limited' });
		now = new Date('2026-08-21T00:00:01.001Z');
		expect(limiter.check('203.0.113.5', 'user:1')).toEqual({ status: 'ok' });
	});

	it('clears all principal, IP, and ban state on close', () => {
		const limiter = create();
		limiter.check('203.0.113.6', 'user:1');
		limiter.addBan('198.51.100.2');
		limiter.close();
		expect(limiter._bucketSize()).toBe(0);
		expect(limiter._ipBucketSize()).toBe(0);
		expect(limiter._bannedSize()).toBe(0);
	});
});
