import type { GameUploadCompleteResponse } from '@pcu/contracts';
import { AppError, badRequest } from '../../../shared/errors.js';
import { loadSession } from './session-loader.js';
import { assertGameUploadSessionWritable } from './session-policy.js';
import { assertUploadStateTransition } from './state-machine.js';
import { isTerminalUploadFinalizationError } from './finalize-completed-upload.service.js';
import type { GameUploadServiceDependencies } from './ports.js';

/** Finalize a chunked upload: complete S3 multipart, validate ZIP, create GAME asset */
export async function completeSession(
	deps: GameUploadServiceDependencies,
	sessionId: string,
	user: { id: number; role: string },
): Promise<GameUploadCompleteResponse> {
	const session = await loadSession(deps, sessionId, user.id, user.role);

	if (session.status !== 'PENDING') {
		throw badRequest(`Cannot complete: session is ${session.status}`);
	}
	assertUploadStateTransition(session.status, 'COMPLETING');
	assertGameUploadSessionWritable(session.project.status, user.role);

	if (!session.s3UploadId || !session.s3Key) {
		throw new AppError(500, 'Session is missing S3 multipart info', 'INTERNAL_ERROR');
	}

	const uploadedChunks = session.parts.length > 0
		? session.parts.map((part: { partNumber: number }) => part.partNumber - 1)
		: session.uploadedChunks;
	const uploaded = new Set(uploadedChunks);
	const missing: number[] = [];
	for (let i = 0; i < session.totalChunks; i++) {
		if (!uploaded.has(i)) missing.push(i);
	}
	if (missing.length > 0) {
		throw badRequest(`Missing ${missing.length} chunks: [${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}]`);
	}

	const transitioned = await deps.repository.transitionToCompleting(session.id);
	if (transitioned.count === 0) {
		throw badRequest('Session is already being completed by another request');
	}

	let s3Completed = false;
	const storageKey = session.s3Key;
	try {
		const dbParts = await deps.repository.findPartsBySessionId(session.id);
		const parts = dbParts.map((part) => ({ partNumber: part.partNumber, etag: part.etag }));
		if (parts.length !== session.totalChunks) {
			throw new AppError(500, `Part ETag count mismatch: expected ${session.totalChunks}, got ${parts.length}`, 'INTERNAL_ERROR');
		}

		await deps.storage.completeMultipart(
			session.s3Key,
			session.s3UploadId,
			parts,
		);
		s3Completed = true;

		const head = await deps.storage.head(storageKey);
		if (!head) {
			throw new AppError(500, 'Completed object not found in S3', 'INTERNAL_ERROR');
		}
		return await deps.finalizer.finalize({
			id: session.id,
			projectId: session.projectId,
			uploadKind: session.uploadKind,
			originalName: session.originalName,
			totalBytes: session.totalBytes,
			s3Key: storageKey,
		}, head);
	} catch (err) {
		if (!s3Completed) {
			try {
				s3Completed = await deps.storage.head(storageKey) !== null;
			} catch (inspectionError) {
				deps.logger.error(
					{ err: inspectionError, sessionId: session.id, storageKey },
					'Could not determine whether multipart completion created the final object; preserving COMPLETING state',
				);
				throw err;
			}
		}

		if (s3Completed) {
			if (isTerminalUploadFinalizationError(err)) {
				await deps.repository.markFailed(session.id, storageKey).catch((markErr) => {
					deps.logger.error({ err: markErr, sessionId: session.id }, 'Failed to mark invalid completed upload FAILED');
				});
				await deps.deleteOrQueue(
					storageKey,
					session.uploadKind === 'WEBGL'
						? 'webgl-upload-completion-invalid'
						: 'game-upload-completion-invalid',
					{ sessionId: session.id },
				);
			} else {
				deps.logger.warn(
					{ err, sessionId: session.id, storageKey },
					'Upload finalization failed after storage completion; preserving for restart recovery',
				);
			}
		} else {
			assertUploadStateTransition('COMPLETING', 'PENDING');
			await deps.repository.revertToPending(session.id).catch((revertErr) => {
				deps.logger.error({ err: revertErr, sessionId: session.id }, 'Failed to revert session to PENDING after pre-S3-complete error');
			});
		}
		throw err;
	}
}
