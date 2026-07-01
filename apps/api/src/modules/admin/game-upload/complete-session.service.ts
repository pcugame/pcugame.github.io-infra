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
import { replaceOrCreateReplaceableAsset } from '../project/repository.js';
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

	const uploaded = new Set(session.uploadedChunks);
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

	try {
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

		const head = await headObject(cfg.S3_BUCKET_PROTECTED, session.s3Key);
		if (!head) {
			throw new AppError(500, 'Completed object not found in S3', 'INTERNAL_ERROR');
		}
		if (head.size !== Number(session.totalBytes)) {
			await safeDeleteObject(cfg.S3_BUCKET_PROTECTED, session.s3Key, 'game-upload-size-mismatch', { sessionId: session.id });
			throw new AppError(500, `Final file size mismatch: expected ${session.totalBytes}, got ${head.size}`, 'SIZE_MISMATCH');
		}

		const header = await readObjectRange(cfg.S3_BUCKET_PROTECTED, session.s3Key, 0, 7);
		const detected = detectFileType(header);
		if (!detected || !isAllowedGameType(detected)) {
			await safeDeleteObject(cfg.S3_BUCKET_PROTECTED, session.s3Key, 'game-upload-invalid-zip', { sessionId: session.id });
			throw badRequest('Uploaded file is not a valid ZIP archive');
		}
		try {
			await validateZipArchiveObject(cfg.S3_BUCKET_PROTECTED, session.s3Key, head.size);
		} catch (err) {
			await safeDeleteObject(cfg.S3_BUCKET_PROTECTED, session.s3Key, 'game-upload-unsafe-zip', { sessionId: session.id });
			throw err;
		}

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
			logger().error({ err: revertErr, sessionId: session.id }, 'Failed to revert session to PENDING after completion error; session may be stuck in COMPLETING');
		});
		throw err;
	}
}
