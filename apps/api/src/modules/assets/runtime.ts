import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { bucketForKind } from '../../lib/s3.js';
import { getPresignedUrl } from '../../lib/storage.js';
import { safeDeleteObject } from '../../object-deletion.js';
import { protectedDownloadLimiter } from '../../shared/protected-download-limiter.js';
import { loadProjectWithAccess } from '../admin/project-access.js';
import * as repository from './repository.js';
import { createAssetsService } from './service.js';

function dependencies() {
	const config = env();
	return {
		publicBucket: config.S3_BUCKET_PUBLIC,
		protectedBucket: config.S3_BUCKET_PROTECTED,
		presign: getPresignedUrl,
		bucketForKind,
		deleteOrQueue: safeDeleteObject,
		loadProjectWithAccess,
		downloadLimiter: protectedDownloadLimiter,
		logger: logger(),
		repository,
	};
}

let productionService: ReturnType<typeof createAssetsService> | undefined;

function service() {
	productionService ??= createAssetsService(dependencies());
	return productionService;
}

export const assetsService: ReturnType<typeof createAssetsService> = {
	loadBannedIpCache: () => service().loadBannedIpCache(),
	streamPublicAsset: (storageKey) => service().streamPublicAsset(storageKey),
	streamProtectedAsset: (storageKey, clientIp, user) => (
		service().streamProtectedAsset(storageKey, clientIp, user)
	),
	deleteAsset: (assetId, actor) => service().deleteAsset(assetId, actor),
};
