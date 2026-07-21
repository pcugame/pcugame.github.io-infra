import { randomUUID } from 'node:crypto';
import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import { isAcceptingNewWork } from '../../../lib/lifecycle.js';
import {
	abortMultipartUpload,
	completeMultipartUpload,
	createMultipartUpload,
	headObject,
	uploadPart,
} from '../../../lib/storage.js';
import { safeDeleteObject } from '../../../object-deletion.js';
import { getSiteSettings } from '../../../shared/site-settings.js';
import { generateStorageKey } from '../../../shared/storage-path.js';
import {
	acquireUploadSlot,
	getUploadLimits,
	releaseUploadSlot,
} from '../../../shared/upload-limits.js';
import { storageOptionsForAsset } from '../../assets/upload/storage-policy.js';
import { createWebglDeploymentKeys } from '../../webgl/paths.js';
import { completedUploadFinalizer } from './finalize-completed-upload.runtime.js';
import * as repository from './repository.js';
import { createGameUploadService } from './service.js';
import type { GameUploadServiceDependencies } from './ports.js';

function dependencies(): GameUploadServiceDependencies {
	const config = env();
	const protectedBucket = config.S3_BUCKET_PROTECTED;
	return {
		repository,
		storage: {
			createMultipart: (key) => createMultipartUpload(
				protectedBucket,
				key,
				'application/zip',
				storageOptionsForAsset('GAME', 'original'),
			),
			abortMultipart: (key, uploadId) => abortMultipartUpload(protectedBucket, key, uploadId),
			uploadPart: (key, uploadId, partNumber, body, contentLength) => uploadPart(
				protectedBucket,
				key,
				uploadId,
				partNumber,
				body,
				contentLength,
			),
			completeMultipart: (key, uploadId, parts) => completeMultipartUpload(
				protectedBucket,
				key,
				uploadId,
				parts,
			),
			head: (key) => headObject(protectedBucket, key),
		},
		finalizer: completedUploadFinalizer,
		settings: { get: getSiteSettings },
		uploadSlots: { acquire: acquireUploadSlot, release: releaseUploadSlot },
		clock: { now: () => new Date() },
		ids: { next: randomUUID },
		lifecycle: { isAcceptingNewWork },
		config: {
			uploadChunkSizeMb: config.UPLOAD_CHUNK_SIZE_MB,
			uploadSessionTtlMinutes: config.UPLOAD_SESSION_TTL_MINUTES,
		},
		roleGameMaxBytes: (role) => getUploadLimits(role).gameMaxBytes,
		storageKey: (uploadKind, projectId) => uploadKind === 'WEBGL'
			? createWebglDeploymentKeys(projectId).sourceKey
			: generateStorageKey('zip'),
		deleteOrQueue: (key, reason, context) => safeDeleteObject(
			protectedBucket,
			key,
			reason,
			context,
		),
		logger: {
			error: (context, message) => logger().error(context, message),
			warn: (context, message) => logger().warn(context, message),
		},
	};
}

let productionService: ReturnType<typeof createGameUploadService> | undefined;

function service() {
	productionService ??= createGameUploadService(dependencies());
	return productionService;
}

export const gameUploadService = {
	createSession: (...args: Parameters<ReturnType<typeof service>['createSession']>) => service().createSession(...args),
	uploadChunk: (...args: Parameters<ReturnType<typeof service>['uploadChunk']>) => service().uploadChunk(...args),
	completeSession: (...args: Parameters<ReturnType<typeof service>['completeSession']>) => service().completeSession(...args),
	cancelSession: (...args: Parameters<ReturnType<typeof service>['cancelSession']>) => service().cancelSession(...args),
	getSessionStatus: (...args: Parameters<ReturnType<typeof service>['getSessionStatus']>) => service().getSessionStatus(...args),
	listSessions: (...args: Parameters<ReturnType<typeof service>['listSessions']>) => service().listSessions(...args),
	sweepStaleCompletingSessions: () => service().sweepStaleCompletingSessions(),
	chunkUploadBodyLimitBytes: () => {
		const config = env();
		return Math.max(1, Math.floor(config.UPLOAD_CHUNK_SIZE_MB * 1024 * 1024));
	},
};
