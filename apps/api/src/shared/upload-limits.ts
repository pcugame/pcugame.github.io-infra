/**
 * Role-based upload limits and streaming enforcement utilities.
 *
 * USER gets tighter limits. OPERATOR/ADMIN get higher limits.
 * Stateful concurrency is created explicitly by the composition root.
 */

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
		close(): void {
			if (closed) return;
			closed = true;
			activeUploads = 0;
		},
	};
}
