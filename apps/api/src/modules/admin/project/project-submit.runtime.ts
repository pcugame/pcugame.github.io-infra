import { env } from '../../../config/env.js';
import {
	acquireUploadSlot,
	getUploadLimits,
	releaseUploadSlot,
} from '../../../shared/upload-limits.js';
import { UploadPipeline } from '../../assets/upload/index.js';
import { collectMultipartParts } from '../../assets/upload/multipart-collector.js';
import * as repository from './repository.js';
import { createSubmitProjectService } from './project-submit.service.js';

let productionService: ReturnType<typeof createSubmitProjectService> | undefined;

function service() {
	productionService ??= createSubmitProjectService({
		webPublicUrl: env().WEB_PUBLIC_URL,
		repository,
		uploadLimits: getUploadLimits,
		uploadSlots: { acquire: acquireUploadSlot, release: releaseUploadSlot },
		createPipeline: () => new UploadPipeline(),
		multipartCollector: { collect: collectMultipartParts },
	});
	return productionService;
}

export const submitProject: ReturnType<typeof createSubmitProjectService>['submitProject'] = (...args) => (
	service().submitProject(...args)
);
