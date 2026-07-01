import type { GameUploadStatus } from '@pcu/contracts';
import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import { abortMultipartUpload } from '../../../lib/storage.js';
import { badRequest } from '../../../shared/errors.js';
import { loadSession } from './session-loader.js';
import * as repo from './repository.js';

/** Get current session status and progress */
export async function getSessionStatus(
	sessionId: string,
	user: { id: number; role: string },
): Promise<GameUploadStatus> {
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
 * back to PENDING (the interrupted `completeSession` cannot resume, but the user can retry)
 * and abort the orphan S3 multipart upload so parts do not accumulate.
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
): Promise<GameUploadStatus[]> {
	const isPrivileged = user.role === 'ADMIN' || user.role === 'OPERATOR';
	const sessions = await repo.findActiveSessionsForListing(
		projectId,
		isPrivileged ? {} : { userId: user.id },
	);

	return sessions.map((s) => ({
		sessionId: s.id,
		projectId: s.projectId,
		originalName: s.originalName,
		totalBytes: Number(s.totalBytes),
		chunkSizeBytes: s.chunkSizeBytes,
		totalChunks: s.totalChunks,
		uploadedChunks: s.uploadedChunks,
		uploadedCount: s.uploadedChunks.length,
		status: s.status,
		expiresAt: s.expiresAt.toISOString(),
	}));
}
