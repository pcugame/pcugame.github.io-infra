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
