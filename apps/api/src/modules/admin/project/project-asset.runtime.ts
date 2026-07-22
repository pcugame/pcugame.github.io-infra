import { bucketForKind } from '../../../lib/s3.js';
import { deleteDurablyQueuedObject } from '../../../object-deletion.js';
import { deleteUnpersistedAssetUpload } from './asset-cleanup.js';
import {
	acquireUploadSlot,
	getUploadLimits,
	releaseUploadSlot,
} from '../../../shared/upload-limits.js';
import * as repository from './repository.js';
import { assetUrl } from './serializer.runtime.js';
import { singleAssetUploadCoordinator } from './project-asset-upload.adapter.js';
import { createProjectAssetService } from './project-asset.service.js';

export const projectAssetService = createProjectAssetService({
	repository,
	uploadLimits: getUploadLimits,
	uploadSlots: { acquire: acquireUploadSlot, release: releaseUploadSlot },
	uploadCoordinator: singleAssetUploadCoordinator,
	assetUrl,
	bucketForKind,
	deleteOrQueue: deleteDurablyQueuedObject,
	deleteUnpersistedUpload: deleteUnpersistedAssetUpload,
});

export const { addAssetToProject } = projectAssetService;
