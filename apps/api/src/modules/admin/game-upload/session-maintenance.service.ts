import type { GameUploadStatus } from '@pcu/contracts';
import { badRequest } from '../../../shared/errors.js';
import { loadSession } from './session-loader.js';
import { assertUploadStateTransition } from './state-machine.js';
import { isTerminalUploadFinalizationError } from './finalize-completed-upload.service.js';
import type { GameUploadServiceDependencies } from './ports.js';

/** Get current session status and progress */
export async function getSessionStatus(
	deps: GameUploadServiceDependencies,
	sessionId: string,
	user: { id: number; role: string },
): Promise<GameUploadStatus> {
	const session = await loadSession(deps, sessionId, user.id, user.role);
	const uploadedChunks = uploadedChunksForSession(session);
	return {
		sessionId: session.id,
		projectId: session.projectId,
		uploadKind: session.uploadKind,
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
	deps: GameUploadServiceDependencies,
	sessionId: string,
	user: { id: number; role: string },
) {
	const session = await loadSession(deps, sessionId, user.id, user.role);

	if (session.status === 'COMPLETED') {
		throw badRequest('Cannot cancel a completed session');
	}
	assertUploadStateTransition(session.status, 'CANCELLED');

	const cancelled = await deps.repository.cancelSessionAndClearActive(session.id);
	if (cancelled.count === 0) {
		throw badRequest('Session state changed before it could be cancelled');
	}
	if (session.s3UploadId && session.s3Key) {
		await deps.storage.abortMultipart(session.s3Key, session.s3UploadId).catch((err) => {
			deps.logger.error({ err, sessionId: session.id, s3Key: session.s3Key }, 'Failed to abort multipart upload during cancelSession');
		});
	}
}

/**
 * Boot-time sweep: sessions stuck in COMPLETING cannot be blindly made writable again
 * after S3 may have completed. If the final object exists, leave the row for explicit
 * completion repair paths; otherwise abort the multipart upload and mark terminal FAILED.
 */
export async function sweepStaleCompletingSessions(
	deps: GameUploadServiceDependencies,
): Promise<{ swept: number }> {
	const cutoff = new Date(deps.clock.now().getTime() - 5 * 60 * 1000);
	const stale = await deps.repository.findStaleCompletingSessions(cutoff);
	if (stale.length === 0) return { swept: 0 };

	for (const s of stale) {
		if (!s.s3Key) {
			await deps.repository.markFailed(s.id).catch((err) => {
				deps.logger.error({ err, sessionId: s.id }, 'Boot sweep: failed to mark stale COMPLETING session failed');
			});
			continue;
		}

		let finalObject: Awaited<ReturnType<GameUploadServiceDependencies['storage']['head']>>;
		try {
			finalObject = await deps.storage.head(s.s3Key);
		} catch (err) {
			deps.logger.error(
				{ err, sessionId: s.id, s3Key: s.s3Key },
				'Boot sweep: failed to inspect stale COMPLETING object; leaving it recoverable',
			);
			continue;
		}
		if (finalObject) {
			try {
				await deps.finalizer.finalize({
					id: s.id,
					projectId: s.projectId,
					uploadKind: s.uploadKind,
					originalName: s.originalName,
					totalBytes: s.totalBytes,
					s3Key: s.s3Key,
				}, finalObject);
			} catch (err) {
				if (isTerminalUploadFinalizationError(err)) {
					deps.logger.error({ err, sessionId: s.id, s3Key: s.s3Key }, 'Boot sweep: completed upload is invalid');
					await deps.repository.markFailed(s.id, s.s3Key).catch((markErr) => {
						deps.logger.error({ err: markErr, sessionId: s.id }, 'Boot sweep: failed to mark invalid COMPLETING session failed');
					});
					await deps.deleteOrQueue(
						s.s3Key,
						s.uploadKind === 'WEBGL'
							? 'webgl-upload-sweep-invalid'
							: 'game-upload-sweep-invalid',
						{ sessionId: s.id },
					);
				} else {
					deps.logger.error(
						{ err, sessionId: s.id, s3Key: s.s3Key },
						'Boot sweep: transient finalization failure; leaving session recoverable',
					);
				}
			}
			continue;
		}

		if (s.s3UploadId) {
			await deps.storage.abortMultipart(s.s3Key, s.s3UploadId).catch((err) => {
				deps.logger.error({ err, sessionId: s.id, s3Key: s.s3Key }, 'Boot sweep: failed to abort leftover multipart');
			});
		}
		await deps.repository.markFailed(s.id).catch((err) => {
			deps.logger.error({ err, sessionId: s.id }, 'Boot sweep: failed to mark stale COMPLETING session failed');
		});
	}
	deps.logger.warn({ count: stale.length }, 'Boot sweep: inspected stale COMPLETING sessions');
	return { swept: stale.length };
}

/** List active upload sessions for a project */
export async function listSessions(
	deps: GameUploadServiceDependencies,
	projectId: number,
	user: { id: number; role: string },
): Promise<GameUploadStatus[]> {
	const isPrivileged = user.role === 'ADMIN' || user.role === 'OPERATOR';
	const sessions = await deps.repository.findActiveSessionsForListing(
		projectId,
		isPrivileged ? {} : { userId: user.id },
	);

	return sessions.map((s) => {
		const uploadedChunks = uploadedChunksForSession(s);
		return {
			sessionId: s.id,
			projectId: s.projectId,
			uploadKind: s.uploadKind,
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
