/**
 * Resumable chunked game-file upload service (S3 multipart).
 *
 * Flow:
 *   1. createSession()   → create S3 multipart upload + DB session
 *   2. uploadChunk()     → upload one S3 part
 *   3. getSessionStatus()→ query progress
 *   4. completeSession() → complete multipart upload → GAME asset
 *   5. cancelSession()   → abort multipart upload + cleanup
 */

import { env } from '../../../config/env.js';
import { badRequest, forbidden, notFound, AppError } from '../../../shared/errors.js';
import { isAcceptingNewWork } from '../../../lib/lifecycle.js';
import { generateStorageKey } from '../../../shared/storage-path.js';
import { getUploadLimits } from '../../../shared/upload-limits.js';
import { detectFileType, isAllowedGameType } from '../../../shared/file-signature.js';
import { getSiteSettings } from '../../../shared/site-settings.js';
import { logger } from '../../../lib/logger.js';
import {
	createMultipartUpload,
	uploadPart,
	completeMultipartUpload,
	abortMultipartUpload,
	headObject,
	readObjectRange,
	safeDeleteObject,
} from '../../../lib/storage.js';
import { assertUploadAllowed } from '../upload-guard.js';
import { replaceOrCreateReplaceableAsset } from '../project/repository.js';
import * as repo from './repository.js';

// ── Helpers ─────────────────────────────────────────────────

/** Load and validate a session (ownership, expiry) */
async function loadSession(sessionId: string, userId: number, userRole: string) {
	const session = await repo.findSessionById(sessionId);
	if (!session) throw notFound('Upload session not found');

	const isPrivileged = userRole === 'ADMIN' || userRole === 'OPERATOR';
	if (!isPrivileged && session.userId !== userId) {
		throw forbidden('Not your upload session');
	}

	if (session.expiresAt < new Date()) {
		await repo.updateSessionStatus(session.id, 'CANCELLED');
		if (session.s3UploadId && session.s3Key) {
			await abortMultipartUpload(env().S3_BUCKET_PROTECTED, session.s3Key, session.s3UploadId).catch((err) => {
				logger().error({ err, sessionId: session.id, s3Key: session.s3Key }, 'Failed to abort multipart upload for expired session');
			});
		}
		throw badRequest('Upload session has expired');
	}

	return session;
}

// ── Service methods ─────────────────────────────────────────

/** Create a new chunked upload session for a project */
export async function createSession(
	projectId: number,
	exhibitionId: number,
	user: { id: number; role: string },
	body: { originalName?: string; totalBytes?: number },
) {
	// Refuse to start new multi-chunk sessions once shutdown has begun — in-flight
	// `complete` calls are still allowed so existing uploads don't get truncated.
	if (!isAcceptingNewWork()) {
		throw new AppError(503, 'Server is restarting — please retry in a moment', 'DRAINING');
	}

	if (!body?.originalName || !body?.totalBytes) {
		throw badRequest('Missing originalName or totalBytes');
	}

	const cfg = env();
	const { originalName, totalBytes } = body;

	// Enforce exhibition upload lock
	const exhibition = await repo.findExhibitionById(exhibitionId);
	assertUploadAllowed(exhibition, exhibition?.year ?? 0, user.role as any);

	// Read dynamic limit from DB
	const settings = await getSiteSettings();
	const maxGameBytes = settings.maxGameFileMb * 1024 * 1024;
	const chunkSizeBytes = settings.maxChunkSizeMb * 1024 * 1024;

	// Apply role-based limit
	const roleLimits = getUploadLimits(user.role as any);
	const effectiveMax = Math.min(maxGameBytes, roleLimits.gameMaxBytes);

	if (totalBytes <= 0) throw badRequest('totalBytes must be positive');
	if (totalBytes > effectiveMax) {
		const maxMB = Math.round(effectiveMax / 1024 / 1024);
		throw badRequest(`File size ${Math.round(totalBytes / 1024 / 1024)}MB exceeds max ${maxMB}MB`);
	}

	// Cancel existing active sessions for this project
	const existing = await repo.findActiveSessions(projectId);
	for (const s of existing) {
		await repo.updateSessionStatus(s.id, 'CANCELLED');
		if (s.s3UploadId && s.s3Key) {
			await abortMultipartUpload(cfg.S3_BUCKET_PROTECTED, s.s3Key, s.s3UploadId).catch((err) => {
				logger().error({ err, sessionId: s.id, s3Key: s.s3Key }, 'Failed to abort multipart upload while replacing active session');
			});
		}
	}

	const totalChunks = Math.ceil(totalBytes / chunkSizeBytes);
	const s3Key = generateStorageKey('zip');

	// Start S3 multipart upload
	const s3UploadId = await createMultipartUpload(cfg.S3_BUCKET_PROTECTED, s3Key);

	const expiresAt = new Date(Date.now() + cfg.UPLOAD_SESSION_TTL_MINUTES * 60 * 1000);

	const session = await repo.createSession({
		id: crypto.randomUUID(),
		projectId,
		userId: user.id,
		originalName,
		totalBytes: BigInt(totalBytes),
		chunkSizeBytes,
		totalChunks,
		s3UploadId,
		s3Key,
		expiresAt,
	});

	return {
		sessionId: session.id,
		chunkSizeBytes,
		totalChunks,
		expiresAt: expiresAt.toISOString(),
	};
}

/** Upload one chunk as an S3 multipart part */
export async function uploadChunk(
	sessionId: string,
	chunkIndex: number,
	body: NodeJS.ReadableStream,
	user: { id: number; role: string },
) {
	const session = await loadSession(sessionId, user.id, user.role);

	if (session.status !== 'PENDING') {
		throw badRequest(`Cannot upload chunks: session is ${session.status}`);
	}

	if (isNaN(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
		throw badRequest(`Invalid chunk index: must be 0..${session.totalChunks - 1}`);
	}

	if (!session.s3UploadId || !session.s3Key) {
		throw new AppError(500, 'Session is missing S3 multipart info', 'INTERNAL_ERROR');
	}

	const isLastChunk = chunkIndex === session.totalChunks - 1;
	const expectedSize = isLastChunk
		? Number(session.totalBytes) - chunkIndex * session.chunkSizeBytes
		: session.chunkSizeBytes;

	// Collect the chunk into a buffer for S3 (S3 requires content-length)
	const chunks: Buffer[] = [];
	let bytesWritten = 0;
	for await (const chunk of body as AsyncIterable<Buffer>) {
		bytesWritten += chunk.length;
		if (bytesWritten > expectedSize + 4096) {
			throw new AppError(413, `Chunk ${chunkIndex} exceeds expected size`, 'PAYLOAD_TOO_LARGE');
		}
		chunks.push(chunk);
	}

	if (!isLastChunk && bytesWritten !== expectedSize) {
		throw badRequest(`Chunk ${chunkIndex}: expected ${expectedSize} bytes, got ${bytesWritten}`);
	}

	const buffer = Buffer.concat(chunks);
	const cfg = env();
	const partNumber = chunkIndex + 1; // S3 parts are 1-based

	const etag = await uploadPart(
		cfg.S3_BUCKET_PROTECTED,
		session.s3Key,
		session.s3UploadId,
		partNumber,
		buffer,
		buffer.length,
	);

	// Store ETag and append chunk index
	await repo.appendPartEtag(session.id, partNumber, etag);
	const updated = await repo.appendChunkIndex(session.id, chunkIndex);
	const newChunks = updated[0]?.uploaded_chunks ?? [];

	return {
		index: chunkIndex,
		bytesWritten,
		uploadedCount: newChunks.length,
		totalChunks: session.totalChunks,
	};
}

/** Get current session status and progress */
export async function getSessionStatus(
	sessionId: string,
	user: { id: number; role: string },
) {
	const session = await loadSession(sessionId, user.id, user.role);
	return {
		sessionId: session.id,
		projectId: session.projectId,
		originalName: session.originalName,
		totalBytes: Number(session.totalBytes),
		chunkSizeBytes: session.chunkSizeBytes,
		totalChunks: session.totalChunks,
		uploadedChunks: session.uploadedChunks,
		uploadedCount: session.uploadedChunks.length,
		status: session.status,
		expiresAt: session.expiresAt.toISOString(),
	};
}

/** Finalize a chunked upload: complete S3 multipart, validate ZIP, create GAME asset */
export async function completeSession(
	sessionId: string,
	user: { id: number; role: string },
) {
	const cfg = env();
	const session = await loadSession(sessionId, user.id, user.role);

	if (session.status !== 'PENDING') {
		throw badRequest(`Cannot complete: session is ${session.status}`);
	}

	if (!session.s3UploadId || !session.s3Key) {
		throw new AppError(500, 'Session is missing S3 multipart info', 'INTERNAL_ERROR');
	}

	// Verify all chunks present
	const uploaded = new Set(session.uploadedChunks);
	const missing: number[] = [];
	for (let i = 0; i < session.totalChunks; i++) {
		if (!uploaded.has(i)) missing.push(i);
	}
	if (missing.length > 0) {
		throw badRequest(`Missing ${missing.length} chunks: [${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}]`);
	}

	// Atomically transition PENDING → COMPLETING
	const transitioned = await repo.transitionToCompleting(session.id);
	if (transitioned.count === 0) {
		throw badRequest('Session is already being completed by another request');
	}

	try {
		// Complete the S3 multipart upload
		const parts = (session.s3PartEtags as { partNumber: number; etag: string }[] | null) ?? [];
		if (parts.length !== session.totalChunks) {
			throw new AppError(500, `Part ETag count mismatch: expected ${session.totalChunks}, got ${parts.length}`, 'INTERNAL_ERROR');
		}

		await completeMultipartUpload(
			cfg.S3_BUCKET_PROTECTED,
			session.s3Key,
			session.s3UploadId,
			parts,
		);

		// Verify final size via HeadObject
		const head = await headObject(cfg.S3_BUCKET_PROTECTED, session.s3Key);
		if (!head) {
			throw new AppError(500, 'Completed object not found in S3', 'INTERNAL_ERROR');
		}
		if (head.size !== Number(session.totalBytes)) {
			await safeDeleteObject(cfg.S3_BUCKET_PROTECTED, session.s3Key, 'game-upload-size-mismatch', { sessionId: session.id });
			throw new AppError(500, `Final file size mismatch: expected ${session.totalBytes}, got ${head.size}`, 'SIZE_MISMATCH');
		}

		// Verify ZIP signature via range read
		const header = await readObjectRange(cfg.S3_BUCKET_PROTECTED, session.s3Key, 0, 7);
		const detected = detectFileType(header);
		if (!detected || !isAllowedGameType(detected)) {
			await safeDeleteObject(cfg.S3_BUCKET_PROTECTED, session.s3Key, 'game-upload-invalid-zip', { sessionId: session.id });
			throw badRequest('Uploaded file is not a valid ZIP archive');
		}

		// Replace existing GAME asset or create new one — single transaction, serialized per project.
		const storageKey = session.s3Key;
		let oldStorageKey: string | null = null;
		try {
			const result = await replaceOrCreateReplaceableAsset(session.projectId, 'GAME', {
				storageKey,
				originalName: session.originalName,
				mimeType: 'application/zip',
				sizeBytes: session.totalBytes,
				isPublic: false,
			});
			oldStorageKey = result.oldStorageKey;
		} catch (dbErr) {
			await safeDeleteObject(cfg.S3_BUCKET_PROTECTED, storageKey, 'game-upload-asset-upsert-failed', { sessionId: session.id });
			throw dbErr;
		}

		if (oldStorageKey) {
			await safeDeleteObject(cfg.S3_BUCKET_PROTECTED, oldStorageKey, 'game-upload-replace-previous', { sessionId: session.id });
		}

		await repo.markCompleted(session.id, storageKey);

		return {
			status: 'COMPLETED' as const,
			storageKey,
			sizeBytes: Number(session.totalBytes),
		};
	} catch (err) {
		await repo.revertToPending(session.id).catch((revertErr) => {
			logger().error({ err: revertErr, sessionId: session.id }, 'Failed to revert session to PENDING after completion error — session may be stuck in COMPLETING');
		});
		throw err;
	}
}

/** Cancel an upload session and abort the S3 multipart upload */
export async function cancelSession(
	sessionId: string,
	user: { id: number; role: string },
) {
	const session = await loadSession(sessionId, user.id, user.role);

	if (session.status === 'COMPLETED') {
		throw badRequest('Cannot cancel a completed session');
	}

	await repo.updateSessionStatus(session.id, 'CANCELLED');
	if (session.s3UploadId && session.s3Key) {
		await abortMultipartUpload(env().S3_BUCKET_PROTECTED, session.s3Key, session.s3UploadId).catch((err) => {
			logger().error({ err, sessionId: session.id, s3Key: session.s3Key }, 'Failed to abort multipart upload during cancelSession');
		});
	}
}

/**
 * Boot-time sweep: revert any upload session stuck in COMPLETING for more than 5 minutes
 * back to PENDING (the interrupted `completeSession` can't resume, but the user can retry)
 * and abort the orphan S3 multipart upload so parts don't accumulate.
 *
 * Called from `server.ts` during startup, before the health endpoint starts accepting OK.
 */
export async function sweepStaleCompletingSessions(): Promise<{ swept: number }> {
	const cutoff = new Date(Date.now() - 5 * 60 * 1000);
	const stale = await repo.findStaleCompletingSessions(cutoff);
	if (stale.length === 0) return { swept: 0 };

	const cfg = env();
	for (const s of stale) {
		await repo.revertToPending(s.id).catch((err) => {
			logger().error({ err, sessionId: s.id }, 'Boot sweep: failed to revert stale COMPLETING session');
		});
		if (s.s3UploadId && s.s3Key) {
			await abortMultipartUpload(cfg.S3_BUCKET_PROTECTED, s.s3Key, s.s3UploadId).catch((err) => {
				logger().error({ err, sessionId: s.id, s3Key: s.s3Key }, 'Boot sweep: failed to abort leftover multipart');
			});
		}
	}
	logger().warn({ count: stale.length }, 'Boot sweep: reverted stale COMPLETING sessions to PENDING');
	return { swept: stale.length };
}

/** List active upload sessions for a project */
export async function listSessions(
	projectId: number,
	user: { id: number; role: string },
) {
	const isPrivileged = user.role === 'ADMIN' || user.role === 'OPERATOR';
	const sessions = await repo.findActiveSessionsForListing(
		projectId,
		isPrivileged ? {} : { userId: user.id },
	);

	return sessions.map((s) => ({
		sessionId: s.id,
		originalName: s.originalName,
		totalBytes: Number(s.totalBytes),
		totalChunks: s.totalChunks,
		uploadedCount: s.uploadedChunks.length,
		status: s.status,
		expiresAt: s.expiresAt.toISOString(),
	}));
}
