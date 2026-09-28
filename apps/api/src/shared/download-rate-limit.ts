/**
 * Principal-scoped protected-download limiter with a separate IP abuse ceiling.
 * Ordinary excess traffic is temporary; only an IP-wide abuse ceiling produces
 * a durable-ban signal. This keeps a school/lab NAT from making 50 authenticated
 * users share one ordinary download bucket.
 */

import { normalizeIpTarget, compileIpTarget } from '@pcu/contracts';
import { AppError } from './errors.js';

interface BucketEntry {
	timestamps: number[];
}

export type DownloadRateLimitResult =
	| { status: 'ok' }
	| { status: 'rate_limited'; retryAfterSec: number }
	| { status: 'abuse_ceiling' };

export interface RateLimitClock {
	now(): Date;
}

export interface RateLimitScheduler {
	every(intervalMs: number, task: () => void): { cancel(): void };
}

export interface DownloadRateLimiterOptions {
	autoIpBanEnabled?: boolean;
	windowMs?: number;
	maxHits?: number;
	maxIpHits?: number;
	sweepIntervalMs?: number;
	clock?: RateLimitClock;
	scheduler?: RateLimitScheduler;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;  // 15 minutes
const DEFAULT_MAX_HITS = 30;                // max downloads per window
const DEFAULT_MAX_IP_HITS = 3_000;          // abuse ceiling, not an ordinary user quota
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;   // cleanup every 5 minutes

export class DownloadRateLimiter {
	private principalBuckets = new Map<string, BucketEntry>();
	private ipBuckets = new Map<string, BucketEntry>();
	private bannedIps = new Map<string, (address: string) => boolean>();
	private readonly autoIpBanEnabled: boolean;
	private readonly windowMs: number;
	private readonly maxHits: number;
	private readonly maxIpHits: number;
	private readonly clock: RateLimitClock;
	private readonly scheduler: RateLimitScheduler;
	private readonly sweepIntervalMs: number;
	private sweepTask: { cancel(): void } | null = null;
	private closed = false;

	constructor(opts: DownloadRateLimiterOptions = {}) {
		this.autoIpBanEnabled = opts.autoIpBanEnabled ?? false;
		this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
		this.maxHits = opts.maxHits ?? DEFAULT_MAX_HITS;
		this.maxIpHits = opts.maxIpHits ?? Math.max(DEFAULT_MAX_IP_HITS, this.maxHits * 100);
		this.sweepIntervalMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
		this.clock = opts.clock ?? { now: () => new Date() };
		this.scheduler = opts.scheduler ?? {
			every(intervalMs: number, task: () => void) {
				const timer = setInterval(task, intervalMs);
				timer.unref();
				return { cancel: () => clearInterval(timer) };
			},
		};
	}

	/** Start periodic stale-bucket cleanup. Construction itself is side-effect free. */
	start(): void {
		this.assertOpen();
		if (this.sweepTask) return;
		this.sweepTask = this.scheduler.every(this.sweepIntervalMs, () => this.sweep());
	}

	/** Load banned IPs from DB on startup. */
	loadBannedIps(ips: string[]): void {
		this.assertOpen();
		this.bannedIps = new Map(ips.map((ip) => [ip, compileIpTarget(ip)]));
	}

	/** Add an IP to the in-memory ban cache (called after DB write). */
	addBan(ip: string): void {
		this.assertOpen();
		this.bannedIps.set(ip, compileIpTarget(ip));
		this.ipBuckets.delete(ip);
	}

	/** Remove an IP from the in-memory ban cache (called after DB delete). */
	removeBan(ip: string): void {
		this.assertOpen();
		this.bannedIps.delete(ip);
	}

	/** Check if IP is banned. */
	isBanned(ip: string): boolean {
		this.assertOpen();
		return [...this.bannedIps.values()].some((matches) => matches(ip));
	}

	/**
	 * Check a principal scope and the independently supplied client IP.
	 *
	 * - If IP is banned → throws 403 immediately.
	 * - If the principal limit is exceeded → returns a temporary rate limit.
	 * - If the IP abuse ceiling is exceeded → returns a durable-ban signal.
	 * - Otherwise records the hit and returns 'ok'.
	 */
	check(ip: string, principalScope?: string): DownloadRateLimitResult {
		this.assertOpen();
		ip = normalizeIpTarget(ip);
		principalScope ??= `anonymous:${ip}`;
		if (this.isBanned(ip)) {
			throw new AppError(
				403,
				'Downloads from your IP address are blocked.',
				'IP_BANNED',
			);
		}

		const now = this.clock.now().getTime();
		const cutoff = now - this.windowMs;

		if (this.autoIpBanEnabled) {
			const ipEntry = this.liveBucket(this.ipBuckets, ip, cutoff);
			if (ipEntry.timestamps.length >= this.maxIpHits) {
				// Persistence owner installs the ban only after a successful DB write.
				return { status: 'abuse_ceiling' };
			}
			ipEntry.timestamps.push(now);
		}

		const principalEntry = this.liveBucket(this.principalBuckets, principalScope, cutoff);
		if (principalEntry.timestamps.length >= this.maxHits) {
			const retryAfterMs = Math.max(1, principalEntry.timestamps[0]! + this.windowMs - now);
			return { status: 'rate_limited', retryAfterSec: Math.ceil(retryAfterMs / 1000) };
		}
		principalEntry.timestamps.push(now);
		return { status: 'ok' };
	}

	private liveBucket(buckets: Map<string, BucketEntry>, key: string, cutoff: number): BucketEntry {
		let entry = buckets.get(key);
		if (!entry) {
			entry = { timestamps: [] };
			buckets.set(key, entry);
		}
		entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > cutoff);
		return entry;
	}

	private sweep(): void {
		if (this.closed) return;
		const cutoff = this.clock.now().getTime() - this.windowMs;
		for (const buckets of [this.principalBuckets, this.ipBuckets]) {
			for (const [key, entry] of buckets) {
				entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > cutoff);
				if (entry.timestamps.length === 0) buckets.delete(key);
			}
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.sweepTask) {
			this.sweepTask.cancel();
			this.sweepTask = null;
		}
		this.principalBuckets.clear();
		this.ipBuckets.clear();
		this.bannedIps.clear();
	}

	/** Exposed for testing. */
	_bucketSize(): number {
		return this.principalBuckets.size;
	}

	_ipBucketSize(): number {
		return this.ipBuckets.size;
	}

	_bannedSize(): number {
		return this.bannedIps.size;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('Download rate limiter is closed');
	}
}

export function createDownloadRateLimiter(
	opts: DownloadRateLimiterOptions = {},
): DownloadRateLimiter {
	return new DownloadRateLimiter(opts);
}
