import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import { readObjectRange } from '../../../lib/storage.js';
import { safeDeleteObject } from '../../../object-deletion.js';
import { validateZipArchiveObject } from '../../assets/upload/zip-validation.js';
import { cleanupWebglDeployment, cleanupWebglEntry, deployWebglSource } from '../../webgl/deployment.js';
import { webglUrl } from '../../webgl/paths.js';
import * as repository from './repository.js';
import { createCompletedUploadFinalizer } from './finalize-completed-upload.service.js';

type Finalizer = ReturnType<typeof createCompletedUploadFinalizer>;

let productionFinalizer: Finalizer | undefined;

function getProductionFinalizer(): Finalizer {
	if (productionFinalizer) return productionFinalizer;
	const config = env();
	productionFinalizer = createCompletedUploadFinalizer({
		readHeader: (key) => readObjectRange(config.S3_BUCKET_PROTECTED, key, 0, 7),
		validateGameArchive: async (key, size) => {
			await validateZipArchiveObject(config.S3_BUCKET_PROTECTED, key, size);
		},
		deployWebgl: deployWebglSource,
		cleanupWebglDeployment,
		cleanupWebglEntry,
		finalizeGame: (session) => repository.finalizeCompletedSession(session.id, session.projectId, 'GAME', {
			storageKey: session.s3Key,
			originalName: session.originalName,
			mimeType: 'application/zip',
			sizeBytes: session.totalBytes,
			isPublic: false,
		}),
		finalizeWebgl: (session, deployment) => repository.finalizeCompletedWebglSession(
			session.id,
			session.projectId,
			deployment.entryKey,
			session.s3Key,
		),
		deleteOrQueue: (key, reason, context) => safeDeleteObject(
			config.S3_BUCKET_PROTECTED,
			key,
			reason,
			context,
		),
		webglUrl: (projectId) => webglUrl(config.API_PUBLIC_URL, projectId),
		logError: (context, message) => logger().error(context, message),
	});
	return productionFinalizer;
}

export const completedUploadFinalizer: Finalizer = {
	finalize: (...args) => getProductionFinalizer().finalize(...args),
};
