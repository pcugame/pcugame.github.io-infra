/**
 * Singleton protected asset download rate limiter instance.
 *
 * Shared by protected asset streaming and banned-IP administration so both use
 * the same in-memory ban cache.
 */

import { DownloadRateLimiter } from './download-rate-limit.js';

let processLimiter: DownloadRateLimiter | undefined;

function limiter(): DownloadRateLimiter {
	processLimiter ??= new DownloadRateLimiter({
		windowMs: 15 * 60 * 1000,
		maxHits: 30,
	});
	return processLimiter;
}

/**
 * Lazy process adapter. Importing application modules no longer starts a timer;
 * the timer starts on first production use and is released by BackendContext.
 */
export const protectedDownloadLimiter = {
	loadBannedIps: (ips: string[]) => limiter().loadBannedIps(ips),
	addBan: (ip: string) => limiter().addBan(ip),
	removeBan: (ip: string) => limiter().removeBan(ip),
	isBanned: (ip: string) => limiter().isBanned(ip),
	check: (ip: string) => limiter().check(ip),
	destroy(): void {
		processLimiter?.destroy();
		processLimiter = undefined;
	},
};
