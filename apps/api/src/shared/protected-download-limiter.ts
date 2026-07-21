/**
 * Singleton protected asset download rate limiter instance.
 *
 * Shared by protected asset streaming and banned-IP administration so both use
 * the same in-memory ban cache.
 */

import {
	createDownloadRateLimiter,
	type DownloadRateLimiter,
	type DownloadRateLimiterOptions,
} from './download-rate-limit.js';

export function createProtectedDownloadLimiter(
	options: DownloadRateLimiterOptions = {},
): DownloadRateLimiter {
	return createDownloadRateLimiter({
		windowMs: 15 * 60 * 1000,
		maxHits: 30,
		...options,
	});
}

let processLimiter: DownloadRateLimiter | undefined;

function limiter(): DownloadRateLimiter {
	processLimiter ??= createProtectedDownloadLimiter();
	return processLimiter;
}

function closeProcessLimiter(): void {
	processLimiter?.close();
	processLimiter = undefined;
}

/**
 * Lazy compatibility adapter. Importing or first use does not start a timer;
 * startup code must call `start()`, and BackendContext releases the instance.
 */
export const protectedDownloadLimiter = {
	start: () => limiter().start(),
	loadBannedIps: (ips: string[]) => limiter().loadBannedIps(ips),
	addBan: (ip: string) => limiter().addBan(ip),
	removeBan: (ip: string) => limiter().removeBan(ip),
	isBanned: (ip: string) => limiter().isBanned(ip),
	check: (ip: string) => limiter().check(ip),
	close: closeProcessLimiter,
	destroy: closeProcessLimiter,
};
