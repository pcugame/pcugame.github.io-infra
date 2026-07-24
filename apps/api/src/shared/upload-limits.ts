/**
 * Role-based upload limits and streaming enforcement utilities.
 *
 * USER gets tighter limits. OPERATOR/ADMIN get higher limits.
 * All values are configurable via env() — see config/env.ts.
 */

import type { UserRole } from '@pcu/contracts';
import { env } from '../config/env.js';
import { AppError } from './errors.js';
import type { UploadLimits } from './upload-policy.js';

export {
	createByteLimiter,
	createKindAwareByteLimiter,
	fieldnameToKind,
	kindLimit,
	kindLimitForMime,
	type UploadLimits,
} from './upload-policy.js';

// ── Limit resolution ─────────────────────────────────────────

export function getUploadLimits(role: UserRole): UploadLimits {
	const cfg = env();
	const isPrivileged = role === 'ADMIN' || role === 'OPERATOR';

	if (isPrivileged) {
		return {
			posterMaxBytes: cfg.UPLOAD_PRIVILEGED_IMAGE_MAX_MB * 1024 * 1024,
			imageMaxBytes: cfg.UPLOAD_PRIVILEGED_IMAGE_MAX_MB * 1024 * 1024,
			gameMaxBytes: cfg.UPLOAD_PRIVILEGED_GAME_MAX_MB * 1024 * 1024,
			videoMaxBytes: 1024 * 1024 * 1024,
			requestMaxBytes: cfg.UPLOAD_PRIVILEGED_REQUEST_MAX_MB * 1024 * 1024,
			maxFiles: cfg.UPLOAD_PRIVILEGED_MAX_FILES,
		};
	}

	return {
		posterMaxBytes: cfg.UPLOAD_USER_IMAGE_MAX_MB * 1024 * 1024,
		imageMaxBytes: cfg.UPLOAD_USER_IMAGE_MAX_MB * 1024 * 1024,
		gameMaxBytes: cfg.UPLOAD_USER_GAME_MAX_MB * 1024 * 1024,
		videoMaxBytes: 200 * 1024 * 1024,
		requestMaxBytes: cfg.UPLOAD_USER_REQUEST_MAX_MB * 1024 * 1024,
		maxFiles: cfg.UPLOAD_USER_MAX_FILES,
	};
}

// ── Concurrent upload semaphore ──────────────────────────────

/**
 * Conservative hint clients use to back off before the next attempt. A typical
 * upload finishes in well under a minute; 10s keeps retries responsive while
 * giving the queue room to drain. Emitted as `Retry-After` by the global error
 * handler (see `app.ts`) when this throws 429.
 */
export const UPLOAD_RETRY_AFTER_SEC = 10;

export interface UploadConcurrencyLimiter {
	acquire(override?: number): void;
	release(): void;
	activeCount(): number;
	reset(): void;
	close(): void;
}

export function createUploadLimiter(maxConcurrent: () => number): UploadConcurrencyLimiter {
	let activeUploads = 0;
	let closed = false;
	return {
		acquire(override?: number): void {
			if (closed) throw new Error('Upload limiter is closed');
			const max = override ?? maxConcurrent();
			if (activeUploads >= max) {
				throw new AppError(
					429,
					`Server is processing ${activeUploads} uploads. Please try again shortly.`,
					'TOO_MANY_UPLOADS',
					{ retryAfterSec: UPLOAD_RETRY_AFTER_SEC },
				);
			}
			activeUploads++;
		},
		release(): void {
			if (activeUploads > 0) activeUploads--;
		},
		activeCount: () => activeUploads,
		reset: () => { activeUploads = 0; },
		close(): void {
			if (closed) return;
			closed = true;
			activeUploads = 0;
		},
	};
}

const processUploadLimiter = createUploadLimiter(() => env().UPLOAD_MAX_CONCURRENT);

export const acquireUploadSlot = processUploadLimiter.acquire;
export const releaseUploadSlot = processUploadLimiter.release;
export const activeUploadCount = processUploadLimiter.activeCount;
export const _resetActiveUploads = processUploadLimiter.reset;
