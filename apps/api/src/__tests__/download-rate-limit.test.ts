import { describe, it, expect, afterEach } from 'vitest';
import { DownloadRateLimiter } from '../shared/download-rate-limit.js';
import { AppError } from '../shared/errors.js';

describe('DownloadRateLimiter', () => {
	const limiters: DownloadRateLimiter[] = [];

	function create(opts?: { windowMs?: number; maxHits?: number }) {
		const l = new DownloadRateLimiter(opts);
		limiters.push(l);
		return l;
	}

	afterEach(() => {
		for (const l of limiters) l.destroy();
		limiters.length = 0;
	});

	it('allows requests under the limit', () => {
		const limiter = create({ maxHits: 5, windowMs: 60_000 });
		for (let i = 0; i < 5; i++) {
			expect(limiter.check('1.2.3.4')).toBe('ok');
		}
	});

	it('returns ban when limit is exceeded', () => {
		const limiter = create({ maxHits: 3, windowMs: 60_000 });
		expect(limiter.check('1.2.3.4')).toBe('ok');
		expect(limiter.check('1.2.3.4')).toBe('ok');
		expect(limiter.check('1.2.3.4')).toBe('ok');

		// 4th request exceeds → should signal ban
		expect(limiter.check('1.2.3.4')).toBe('ban');
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
		expect(limiter.check('2.2.2.2')).toBe('ok');
		expect(limiter.check('1.1.1.1')).toBe('ban');
	});

	it('auto-bans after exceeding limit', () => {
		const limiter = create({ maxHits: 1, windowMs: 60_000 });
		limiter.check('1.2.3.4');  // ok

		limiter.check('1.2.3.4');  // ban signal
		expect(limiter.isBanned('1.2.3.4')).toBe(true);

		// Subsequent requests throw 403 immediately
		try {
			limiter.check('1.2.3.4');
			expect.fail('should have thrown');
		} catch (err) {
			expect((err as AppError).statusCode).toBe(403);
		}
	});

	it('removeBan allows IP to download again', () => {
		const limiter = create({ maxHits: 10, windowMs: 60_000 });
		limiter.addBan('1.2.3.4');
		expect(limiter.isBanned('1.2.3.4')).toBe(true);

		limiter.removeBan('1.2.3.4');
		expect(limiter.isBanned('1.2.3.4')).toBe(false);
		expect(limiter.check('1.2.3.4')).toBe('ok');
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
		const limiter = create({ maxHits: 1, windowMs: 1 });
		limiter.check('1.2.3.4');

		const start = Date.now();
		while (Date.now() - start < 5) { /* busy wait 5ms */ }

		expect(limiter.check('1.2.3.4')).toBe('ok');
	});

	it('cleans up on destroy', () => {
		const limiter = create({ maxHits: 10, windowMs: 60_000 });
		limiter.check('1.2.3.4');
		limiter.addBan('5.6.7.8');
		expect(limiter._bucketSize()).toBe(1);
		expect(limiter._bannedSize()).toBe(1);

		limiter.destroy();
		expect(limiter._bucketSize()).toBe(0);
		expect(limiter._bannedSize()).toBe(0);
	});
});
