import { env } from '../../../config/env.js';
import { bucketForKind } from '../../../lib/s3.js';
import { safeDeleteObject } from '../../../object-deletion.js';
import {
	acquireUploadSlot,
	getUploadLimits,
	releaseUploadSlot,
} from '../../../shared/upload-limits.js';
import { exhibitionPosterUploadCoordinator } from './poster-upload.adapter.js';
import * as repository from './repository.js';
import { createExhibitionService } from './service.js';

let productionService: ReturnType<typeof createExhibitionService> | undefined;

function service() {
	productionService ??= createExhibitionService({
		apiPublicUrl: env().API_PUBLIC_URL,
		posterBucket: bucketForKind('POSTER'),
		repository,
		uploadLimits: getUploadLimits,
		uploadSlots: { acquire: acquireUploadSlot, release: releaseUploadSlot },
		posterUpload: exhibitionPosterUploadCoordinator,
		deleteOrQueue: safeDeleteObject,
	});
	return productionService;
}

export const exhibitionService = {
	listExhibitions: () => service().listExhibitions(),
	createExhibition: (...args: Parameters<ReturnType<typeof service>['createExhibition']>) => service().createExhibition(...args),
	deleteExhibition: (...args: Parameters<ReturnType<typeof service>['deleteExhibition']>) => service().deleteExhibition(...args),
	updateExhibition: (...args: Parameters<ReturnType<typeof service>['updateExhibition']>) => service().updateExhibition(...args),
	replacePoster: (...args: Parameters<ReturnType<typeof service>['replacePoster']>) => service().replacePoster(...args),
	deletePoster: (...args: Parameters<ReturnType<typeof service>['deletePoster']>) => service().deletePoster(...args),
};
