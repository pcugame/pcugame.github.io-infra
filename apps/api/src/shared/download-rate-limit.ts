/**
 * In-memory IP-based rate limiter for protected asset downloads.
 *
 * The transient window never mutates the durable denylist. Banned IPs are
 * administrator-managed in the DB and cached here; ordinary excess traffic is
 * throttled only until its sliding window expires.
 */

import { AppError } from './errors.js';

interface BucketEntry {
	timestamps: number[];
}

export type DownloadRateLimitResult =
	| { status: 'ok' }
	| { status: 'rate_limited'; retryAfterSec: number };

export interface RateLimitClock {
	now(): Date;
}

export interface RateLimitScheduler {
	every(intervalMs: number, task: () => void): { cancel(): void };
}

export interface DownloadRateLimiterOptions {
	windowMs?: number;
	maxHits?: number;
	sweepIntervalMs?: number;
	clock?: RateLimitClock;
	scheduler?: RateLimitScheduler;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;  // 15 minutes
const DEFAULT_MAX_HITS = 30;                // max downloads per window
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;   // cleanup every 5 minutes

export class DownloadRateLimiter {
	private buckets = new Map<string, BucketEntry>();
	private bannedIps = new Set<string>();
	private readonly windowMs: number;
	private readonly maxHits: number;
	private readonly clock: RateLimitClock;
	private readonly scheduler: RateLimitScheduler;
	private readonly sweepIntervalMs: number;
	private sweepTask: { cancel(): void } | null = null;
	private closed = false;

	constructor(opts: DownloadRateLimiterOptions = {}) {
		this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
		this.maxHits = opts.maxHits ?? DEFAULT_MAX_HITS;
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
		this.bannedIps = new Set(ips);
	}

	/** Add an IP to the in-memory ban cache (called after DB write). */
	addBan(ip: string): void {
		this.assertOpen();
		this.bannedIps.add(ip);
		for (const key of this.buckets.keys()) {
			if (key.startsWith(`${ip}\u0000`)) this.buckets.delete(key);
		}
	}

	/** Remove an IP from the in-memory ban cache (called after DB delete). */
	removeBan(ip: string): void {
		this.assertOpen();
		this.bannedIps.delete(ip);
	}

	/** Check if IP is banned. */
	isBanned(ip: string): boolean {
		this.assertOpen();
		return this.bannedIps.has(ip);
	}

	/**
	 * Check rate limit for the given IP.
	 *
	 * - If IP is banned → throws 403 immediately.
	 * - If rate limit exceeded → returns a temporary retry hint.
	 * - Otherwise records the hit and returns 'ok'.
	 */
	check(ip: string, scope = ip): DownloadRateLimitResult {
		this.assertOpen();
		if (this.bannedIps.has(ip)) {
			throw new AppError(
				403,
				'Your IP has been blocked by an administrator.',
				'IP_BANNED',
			);
		}

		const now = this.clock.now().getTime();
		const cutoff = now - this.windowMs;

		const bucketKey = `${ip}\u0000${scope}`;
		let entry = this.buckets.get(bucketKey);
		if (!entry) {
			entry = { timestamps: [] };
			this.buckets.set(bucketKey, entry);
		}

		// Remove expired timestamps
		entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

		if (entry.timestamps.length >= this.maxHits) {
			const retryAfterMs = Math.max(1, entry.timestamps[0]! + this.windowMs - now);
			return { status: 'rate_limited', retryAfterSec: Math.ceil(retryAfterMs / 1000) };
		}

		entry.timestamps.push(now);
		return { status: 'ok' };
	}

	private sweep(): void {
		if (this.closed) return;
		const cutoff = this.clock.now().getTime() - this.windowMs;
		for (const [ip, entry] of this.buckets) {
			entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
			if (entry.timestamps.length === 0) {
				this.buckets.delete(ip);
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
		this.buckets.clear();
		this.bannedIps.clear();
	}

	/** Exposed for testing. */
	_bucketSize(): number {
		return this.buckets.size;
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
