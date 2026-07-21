import type { GameUploadCompleteResponse } from '@pcu/contracts';
import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import {
	completeMultipartUpload,
	headObject,
	readObjectRange,
	safeDeleteObject,
} from '../../../lib/storage.js';
import { AppError, badRequest } from '../../../shared/errors.js';
import { detectFileType, isAllowedGameType } from '../../../shared/file-signature.js';
import { validateZipArchiveObject } from '../../assets/upload/zip-validation.js';
import { cleanupWebglDeployment, cleanupWebglEntry, deployWebglSource } from '../../webgl/deployment.js';
import { webglUrl } from '../../webgl/paths.js';
import { loadSession } from './session-loader.js';
import { assertGameUploadSessionWritable } from './session-policy.js';
import * as repo from './repository.js';

/** Finalize a chunked upload: complete S3 multipart, validate ZIP, create GAME asset */
export async function completeSession(
	sessionId: string,
	user: { id: number; role: string },
): Promise<GameUploadCompleteResponse> {
	const cfg = env();
	const session = await loadSession(sessionId, user.id, user.role);

	if (session.status !== 'PENDING') {
		throw badRequest(`Cannot complete: session is ${session.status}`);
	}
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

	const transitioned = await repo.transitionToCompleting(session.id);
	if (transitioned.count === 0) {
		throw badRequest('Session is already being completed by another request');
	}

	let s3Completed = false;
	const storageKey = session.s3Key;
	let deployedWebgl: Awaited<ReturnType<typeof deployWebglSource>> | null = null;
	try {
		const dbParts = await repo.findPartsBySessionId(session.id);
		const parts = dbParts.map((part) => ({ partNumber: part.partNumber, etag: part.etag }));
		if (parts.length !== session.totalChunks) {
			throw new AppError(500, `Part ETag count mismatch: expected ${session.totalChunks}, got ${parts.length}`, 'INTERNAL_ERROR');
		}

		await completeMultipartUpload(
			cfg.S3_BUCKET_PROTECTED,
			session.s3Key,
			session.s3UploadId,
			parts,
		);
		s3Completed = true;

		const head = await headObject(cfg.S3_BUCKET_PROTECTED, storageKey);
		if (!head) {
			throw new AppError(500, 'Completed object not found in S3', 'INTERNAL_ERROR');
		}
		if (head.size !== Number(session.totalBytes)) {
			throw new AppError(500, `Final file size mismatch: expected ${session.totalBytes}, got ${head.size}`, 'SIZE_MISMATCH');
		}

		const header = await readObjectRange(cfg.S3_BUCKET_PROTECTED, storageKey, 0, 7);
		const detected = detectFileType(header);
		if (!detected || !isAllowedGameType(detected)) {
			throw badRequest('Uploaded file is not a valid ZIP archive');
		}
		if (session.uploadKind === 'WEBGL') {
			deployedWebgl = await deployWebglSource(session.projectId, storageKey, head.size);
			const result = await repo.finalizeCompletedWebglSession(
				session.id,
				session.projectId,
				deployedWebgl.entryKey,
				storageKey,
			);
			if (result.oldEntryKey && result.oldEntryKey !== deployedWebgl.entryKey) {
				await cleanupWebglEntry(
					session.projectId,
					result.oldEntryKey,
					'webgl-upload-replace-previous',
				).catch((cleanupErr) => {
					logger().error(
						{ err: cleanupErr, projectId: session.projectId, oldEntryKey: result.oldEntryKey },
						'Failed to clean previous WebGL deployment after pointer swap',
					);
				});
			}
			return {
				status: 'COMPLETED' as const,
				storageKey,
				sizeBytes: Number(session.totalBytes),
				webglUrl: webglUrl(cfg.API_PUBLIC_URL, session.projectId),
			};
		}

		await validateZipArchiveObject(cfg.S3_BUCKET_PROTECTED, storageKey, head.size);

		const result = await repo.finalizeCompletedSession(session.id, session.projectId, 'GAME', {
			storageKey,
			originalName: session.originalName,
			mimeType: 'application/zip',
			sizeBytes: session.totalBytes,
			isPublic: false,
		});

		if (result.oldStorageKey) {
			await safeDeleteObject(cfg.S3_BUCKET_PROTECTED, result.oldStorageKey, 'game-upload-replace-previous', { sessionId: session.id });
		}
		if (result.oldPlaybackStorageKey) {
			await safeDeleteObject(cfg.S3_BUCKET_PROTECTED, result.oldPlaybackStorageKey, 'game-upload-replace-previous-playback', { sessionId: session.id });
		}

		return {
			status: 'COMPLETED' as const,
			storageKey,
			sizeBytes: Number(session.totalBytes),
		};
	} catch (err) {
		if (!s3Completed) {
			const head = await headObject(cfg.S3_BUCKET_PROTECTED, storageKey).catch(() => null);
			s3Completed = !!head;
		}

		if (s3Completed) {
			await repo.markFailed(session.id, storageKey).catch((markErr) => {
				logger().error({ err: markErr, sessionId: session.id }, 'Failed to mark session FAILED after completed-object error');
			});
			if (deployedWebgl) {
				await cleanupWebglDeployment(deployedWebgl, 'webgl-upload-completion-failed');
			} else {
				await safeDeleteObject(
					cfg.S3_BUCKET_PROTECTED,
					storageKey,
					session.uploadKind === 'WEBGL'
						? 'webgl-upload-completion-failed'
						: 'game-upload-completion-failed',
					{ sessionId: session.id },
				);
			}
		} else {
			await repo.revertToPending(session.id).catch((revertErr) => {
				logger().error({ err: revertErr, sessionId: session.id }, 'Failed to revert session to PENDING after pre-S3-complete error');
			});
		}
		throw err;
	}
}
