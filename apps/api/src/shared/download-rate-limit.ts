/**
 * In-memory IP-based rate limiter for protected asset downloads.
 *
 * When an IP exceeds the threshold, it is permanently banned via
 * a callback (which writes to the DB). Subsequent requests from
 * banned IPs are rejected immediately without counting.
 *
 * Banned IPs are cached in-memory for fast lookups; the DB is the
 * source of truth, synced on startup and on ban/unban events.
 */

import { AppError } from './errors.js';

interface BucketEntry {
	timestamps: number[];
}

interface RateLimitClock {
	now(): Date;
}

interface RateLimitScheduler {
	every(intervalMs: number, task: () => void): { cancel(): void };
}

interface DownloadRateLimiterOptions {
	windowMs?: number;
	maxHits?: number;
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
	private sweepTask: { cancel(): void } | null;

	constructor(opts: DownloadRateLimiterOptions = {}) {
		this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
		this.maxHits = opts.maxHits ?? DEFAULT_MAX_HITS;
		this.clock = opts.clock ?? { now: () => new Date() };
		const scheduler = opts.scheduler ?? {
			every(intervalMs: number, task: () => void) {
				const timer = setInterval(task, intervalMs);
				timer.unref();
				return { cancel: () => clearInterval(timer) };
			},
		};

		this.sweepTask = scheduler.every(SWEEP_INTERVAL_MS, () => this.sweep());
	}

	/** Load banned IPs from DB on startup. */
	loadBannedIps(ips: string[]): void {
		this.bannedIps = new Set(ips);
	}

	/** Add an IP to the in-memory ban cache (called after DB write). */
	addBan(ip: string): void {
		this.bannedIps.add(ip);
		this.buckets.delete(ip);
	}

	/** Remove an IP from the in-memory ban cache (called after DB delete). */
	removeBan(ip: string): void {
		this.bannedIps.delete(ip);
	}

	/** Check if IP is banned. */
	isBanned(ip: string): boolean {
		return this.bannedIps.has(ip);
	}

	/**
	 * Check rate limit for the given IP.
	 *
	 * - If IP is banned → throws 403 immediately.
	 * - If rate limit exceeded → returns 'ban' (caller should persist the ban).
	 * - Otherwise records the hit and returns 'ok'.
	 */
	check(ip: string): 'ok' | 'ban' {
		if (this.bannedIps.has(ip)) {
			throw new AppError(
				403,
				'Your IP has been blocked due to excessive download requests.',
				'IP_BANNED',
			);
		}

		const now = this.clock.now().getTime();
		const cutoff = now - this.windowMs;

		let entry = this.buckets.get(ip);
		if (!entry) {
			entry = { timestamps: [] };
			this.buckets.set(ip, entry);
		}

		// Remove expired timestamps
		entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

		if (entry.timestamps.length >= this.maxHits) {
			// Signal caller to persist the ban
			this.bannedIps.add(ip);
			this.buckets.delete(ip);
			return 'ban';
		}

		entry.timestamps.push(now);
		return 'ok';
	}

	private sweep(): void {
		const cutoff = this.clock.now().getTime() - this.windowMs;
		for (const [ip, entry] of this.buckets) {
			entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
			if (entry.timestamps.length === 0) {
				this.buckets.delete(ip);
			}
		}
	}

	destroy(): void {
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
}
