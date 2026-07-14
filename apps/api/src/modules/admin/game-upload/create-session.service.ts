import { randomUUID } from 'node:crypto';
import type { GameUploadSession } from '@pcu/contracts';
import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import { isAcceptingNewWork } from '../../../lib/lifecycle.js';
import { abortMultipartUpload, createMultipartUpload } from '../../../lib/storage.js';
import { AppError, badRequest } from '../../../shared/errors.js';
import { getSiteSettings } from '../../../shared/site-settings.js';
import { generateStorageKey } from '../../../shared/storage-path.js';
import { getUploadLimits } from '../../../shared/upload-limits.js';
import { assertValidUploadFilename } from '../../../shared/filename-validation.js';
import { storageOptionsForAsset } from '../../assets/upload/storage-policy.js';
import { assertUploadAllowed } from '../upload-guard.js';
import { resolveChunkSizeBytes } from './session-sizing.js';
import * as repo from './repository.js';

/** Create a new chunked upload session for a project */
export async function createSession(
	projectId: number,
	exhibitionId: number,
	user: { id: number; role: string },
	body: { originalName?: string; totalBytes?: number },
): Promise<GameUploadSession> {
	// Refuse to start new multi-chunk sessions once shutdown has begun; in-flight
	// completion calls are still allowed so existing uploads do not get truncated.
	if (!isAcceptingNewWork()) {
		throw new AppError(503, 'Server is restarting; please retry in a moment', 'DRAINING');
	}

	if (!body?.originalName || !body?.totalBytes) {
		throw badRequest('Missing originalName or totalBytes');
	}

	const cfg = env();
	const { originalName, totalBytes } = body;
	assertValidUploadFilename(originalName);

	const exhibition = await repo.findExhibitionById(exhibitionId);
	assertUploadAllowed(exhibition, exhibition?.year ?? 0, user.role as any);

	const settings = await getSiteSettings();
	const maxGameBytes = settings.maxGameFileMb * 1024 * 1024;
	const chunkSizeBytes = resolveChunkSizeBytes(settings, cfg);

	const roleLimits = getUploadLimits(user.role as any);
	const effectiveMax = Math.min(maxGameBytes, roleLimits.gameMaxBytes);

	if (totalBytes <= 0) throw badRequest('totalBytes must be positive');
	if (totalBytes > effectiveMax) {
		const maxMB = Math.round(effectiveMax / 1024 / 1024);
		throw badRequest(`File size ${Math.round(totalBytes / 1024 / 1024)}MB exceeds max ${maxMB}MB`);
	}

	const totalChunks = Math.ceil(totalBytes / chunkSizeBytes);
	const s3Key = generateStorageKey('zip');
	const s3UploadId = await createMultipartUpload(
		cfg.S3_BUCKET_PROTECTED,
		s3Key,
		'application/zip',
		storageOptionsForAsset('GAME', 'original'),
	);
	const expiresAt = new Date(Date.now() + cfg.UPLOAD_SESSION_TTL_MINUTES * 60 * 1000);

	let created: Awaited<ReturnType<typeof repo.createSessionReplacingActive>>;
	try {
		created = await repo.createSessionReplacingActive({
			id: randomUUID(),
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
	} catch (err) {
		await abortMultipartUpload(cfg.S3_BUCKET_PROTECTED, s3Key, s3UploadId).catch((abortErr) => {
			logger().error({ err: abortErr, s3Key }, 'Failed to abort new multipart upload after session create failure');
		});
		throw err;
	}

	for (const s of created.replacedSessions) {
		if (s.s3UploadId && s.s3Key) {
			await abortMultipartUpload(cfg.S3_BUCKET_PROTECTED, s.s3Key, s.s3UploadId).catch((err) => {
				logger().error({ err, sessionId: s.id, s3Key: s.s3Key }, 'Failed to abort multipart upload while replacing active session');
			});
		}
	}

	return {
		sessionId: created.session.id,
		chunkSizeBytes,
		totalChunks,
		expiresAt: expiresAt.toISOString(),
	};
}
