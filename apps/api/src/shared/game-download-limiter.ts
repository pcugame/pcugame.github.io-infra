/**
 * Singleton game download rate limiter instance.
 *
 * Extracted to shared so both assets and banned-ip modules
 * can reference the same instance without circular imports.
 */

import { DownloadRateLimiter } from './download-rate-limit.js';

/** 15-minute window, 30 hits max before permanent ban */
export const gameDownloadLimiter = new DownloadRateLimiter({
	windowMs: 15 * 60 * 1000,
	maxHits: 30,
});
