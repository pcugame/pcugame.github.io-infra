import type { GameUploadStatus } from '@pcu/contracts';
import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import { abortMultipartUpload, headObject, readObjectRange, safeDeleteObject } from '../../../lib/storage.js';
import { badRequest } from '../../../shared/errors.js';
import { detectFileType, isAllowedGameType } from '../../../shared/file-signature.js';
import { validateZipArchiveObject } from '../../assets/upload/zip-validation.js';
import { loadSession } from './session-loader.js';
import * as repo from './repository.js';

/** Get current session status and progress */
export async function getSessionStatus(
	sessionId: string,
	user: { id: number; role: string },
): Promise<GameUploadStatus> {
	const session = await loadSession(sessionId, user.id, user.role);
	const uploadedChunks = uploadedChunksForSession(session);
	return {
		sessionId: session.id,
		projectId: session.projectId,
		originalName: session.originalName,
		totalBytes: Number(session.totalBytes),
		chunkSizeBytes: session.chunkSizeBytes,
		totalChunks: session.totalChunks,
		uploadedChunks,
		uploadedCount: uploadedChunks.length,
		status: session.status,
		expiresAt: session.expiresAt.toISOString(),
	};
}

function uploadedChunksForSession(session: { parts?: { partNumber: number }[]; uploadedChunks: number[] }) {
	const partChunks = (session.parts ?? []).map((p) => p.partNumber - 1).sort((a, b) => a - b);
	return partChunks.length > 0 ? partChunks : session.uploadedChunks;
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

	await repo.cancelSessionAndClearActive(session.id);
	if (session.s3UploadId && session.s3Key) {
		await abortMultipartUpload(env().S3_BUCKET_PROTECTED, session.s3Key, session.s3UploadId).catch((err) => {
			logger().error({ err, sessionId: session.id, s3Key: session.s3Key }, 'Failed to abort multipart upload during cancelSession');
		});
	}
}

/**
 * Boot-time sweep: sessions stuck in COMPLETING cannot be blindly made writable again
 * after S3 may have completed. If the final object exists, leave the row for explicit
 * completion repair paths; otherwise abort the multipart upload and mark terminal FAILED.
 */
export async function sweepStaleCompletingSessions(): Promise<{ swept: number }> {
	const cutoff = new Date(Date.now() - 5 * 60 * 1000);
	const stale = await repo.findStaleCompletingSessions(cutoff);
	if (stale.length === 0) return { swept: 0 };

	const cfg = env();
	for (const s of stale) {
		if (!s.s3Key) {
			await repo.markFailed(s.id).catch((err) => {
				logger().error({ err, sessionId: s.id }, 'Boot sweep: failed to mark stale COMPLETING session failed');
			});
			continue;
		}

		const finalObject = await headObject(cfg.S3_BUCKET_PROTECTED, s.s3Key).catch((err) => {
			logger().error({ err, sessionId: s.id, s3Key: s.s3Key }, 'Boot sweep: failed to inspect stale COMPLETING object');
			return null;
		});
		if (finalObject) {
			try {
				if (finalObject.size !== Number(s.totalBytes)) {
					throw new Error(`Final file size mismatch: expected ${s.totalBytes}, got ${finalObject.size}`);
				}
				const header = await readObjectRange(cfg.S3_BUCKET_PROTECTED, s.s3Key, 0, 7);
				const detected = detectFileType(header);
				if (!detected || !isAllowedGameType(detected)) {
					throw new Error('Completed object is not a valid ZIP archive');
				}
				await validateZipArchiveObject(cfg.S3_BUCKET_PROTECTED, s.s3Key, finalObject.size);
				const result = await repo.finalizeCompletedSession(s.id, s.projectId, 'GAME', {
					storageKey: s.s3Key,
					originalName: s.originalName,
					mimeType: 'application/zip',
					sizeBytes: s.totalBytes,
					isPublic: false,
				});
				if (result.oldStorageKey) {
					await safeDeleteObject(cfg.S3_BUCKET_PROTECTED, result.oldStorageKey, 'game-upload-sweep-replace-previous', { sessionId: s.id });
				}
				if (result.oldPlaybackStorageKey) {
					await safeDeleteObject(cfg.S3_BUCKET_PROTECTED, result.oldPlaybackStorageKey, 'game-upload-sweep-replace-previous-playback', { sessionId: s.id });
				}
			} catch (err) {
				logger().error({ err, sessionId: s.id, s3Key: s.s3Key }, 'Boot sweep: failed to repair stale COMPLETING session');
				await repo.markFailed(s.id, s.s3Key).catch((markErr) => {
					logger().error({ err: markErr, sessionId: s.id }, 'Boot sweep: failed to mark unrepaired COMPLETING session failed');
				});
				await safeDeleteObject(cfg.S3_BUCKET_PROTECTED, s.s3Key, 'game-upload-sweep-repair-failed', { sessionId: s.id });
			}
			continue;
		}

		if (s.s3UploadId) {
			await abortMultipartUpload(cfg.S3_BUCKET_PROTECTED, s.s3Key, s.s3UploadId).catch((err) => {
				logger().error({ err, sessionId: s.id, s3Key: s.s3Key }, 'Boot sweep: failed to abort leftover multipart');
			});
		}
		await repo.markFailed(s.id).catch((err) => {
			logger().error({ err, sessionId: s.id }, 'Boot sweep: failed to mark stale COMPLETING session failed');
		});
	}
	logger().warn({ count: stale.length }, 'Boot sweep: inspected stale COMPLETING sessions');
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

	return sessions.map((s) => {
		const uploadedChunks = uploadedChunksForSession(s);
		return {
			sessionId: s.id,
			projectId: s.projectId,
			originalName: s.originalName,
			totalBytes: Number(s.totalBytes),
			chunkSizeBytes: s.chunkSizeBytes,
			totalChunks: s.totalChunks,
			uploadedChunks,
			uploadedCount: uploadedChunks.length,
			status: s.status,
			expiresAt: s.expiresAt.toISOString(),
		};
	});
}
