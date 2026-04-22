/**
 * Role-based upload limits and streaming enforcement utilities.
 *
 * USER gets tighter limits. OPERATOR/ADMIN get higher limits.
 * All values are configurable via env() — see config/env.ts.
 */

import { Transform } from 'node:stream';
import type { UserRole } from '@prisma/client';
import type { AssetKind } from '@prisma/client';
import { env } from '../config/env.js';
import { AppError } from './errors.js';

// ── Limit resolution ─────────────────────────────────────────

export interface UploadLimits {
	/** Max bytes per poster/thumbnail file */
	posterMaxBytes: number;
	/** Max bytes per image file */
	imageMaxBytes: number;
	/** Max bytes per game (ZIP) file */
	gameMaxBytes: number;
	/** Max bytes per video file */
	videoMaxBytes: number;
	/** Max total bytes per request (all files combined) */
	requestMaxBytes: number;
	/** Max number of file parts per request */
	maxFiles: number;
}

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

/** Get the byte limit for a specific asset kind from the resolved limits. */
export function kindLimit(limits: UploadLimits, kind: AssetKind): number {
	switch (kind) {
		case 'GAME': return limits.gameMaxBytes;
		case 'VIDEO': return limits.videoMaxBytes;
		case 'POSTER':
		case 'THUMBNAIL': return limits.posterMaxBytes;
		case 'IMAGE':
		default: return limits.imageMaxBytes;
	}
}

// ── Fieldname → AssetKind (for submit route) ─────────────────

const FIELDNAME_MAP: Record<string, AssetKind> = {
	poster: 'POSTER',
	'images[]': 'IMAGE',
	gameFile: 'GAME',
	videoFile: 'VIDEO',
};

/**
 * Map a multipart fieldname to an AssetKind.
 * Returns undefined for unknown fields (they should be skipped).
 */
export function fieldnameToKind(fieldname: string): AssetKind | undefined {
	return FIELDNAME_MAP[fieldname];
}

// ── Streaming byte limiter ───────────────────────────────────

/**
 * A Transform stream that counts bytes passing through and destroys
 * itself with a 413 error once `maxBytes` is exceeded.
 *
 * This aborts the write to tmp disk as early as possible, rather than
 * waiting for the full file to be written before checking the size.
 */
export function createByteLimiter(maxBytes: number, label = 'File'): Transform {
	let total = 0;
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			total += chunk.length;
			if (total > maxBytes) {
				const limitMB = Math.round(maxBytes / 1024 / 1024);
				callback(
					new AppError(413, `${label} exceeds size limit of ${limitMB}MB`, 'PAYLOAD_TOO_LARGE'),
				);
				return;
			}
			callback(null, chunk);
		},
	});
}

// ── Concurrent upload semaphore ──────────────────────────────

let _activeUploads = 0;

/**
 * Conservative hint clients use to back off before the next attempt. A typical
 * upload finishes in well under a minute; 10s keeps retries responsive while
 * giving the queue room to drain. Emitted as `Retry-After` by the global error
 * handler (see `app.ts`) when this throws 429.
 */
export const UPLOAD_RETRY_AFTER_SEC = 10;

export function acquireUploadSlot(maxConcurrent?: number): void {
	const max = maxConcurrent ?? env().UPLOAD_MAX_CONCURRENT;
	if (_activeUploads >= max) {
		throw new AppError(
			429,
			`Server is processing ${_activeUploads} uploads. Please try again shortly.`,
			'TOO_MANY_UPLOADS',
			{ retryAfterSec: UPLOAD_RETRY_AFTER_SEC },
		);
	}
	_activeUploads++;
}

export function releaseUploadSlot(): void {
	if (_activeUploads > 0) _activeUploads--;
}

/** Current count — exposed for testing. */
export function activeUploadCount(): number {
	return _activeUploads;
}

/** Reset — for testing only. */
export function _resetActiveUploads(): void {
	_activeUploads = 0;
}
