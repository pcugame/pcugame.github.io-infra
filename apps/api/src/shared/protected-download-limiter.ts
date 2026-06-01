/**
 * Singleton protected asset download rate limiter instance.
 *
 * Shared by protected asset streaming and banned-IP administration so both use
 * the same in-memory ban cache.
 */

import { DownloadRateLimiter } from './download-rate-limit.js';

/** 15-minute window, 30 hits max before permanent ban. */
export const protectedDownloadLimiter = new DownloadRateLimiter({
	windowMs: 15 * 60 * 1000,
	maxHits: 30,
});
