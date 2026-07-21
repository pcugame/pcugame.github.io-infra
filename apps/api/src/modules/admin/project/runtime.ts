import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import { abortMultipartUpload } from '../../../lib/storage.js';
import { cleanupWebglDeployment, cleanupWebglEntry } from '../../webgl/deployment.js';
import { deleteAssetObjects } from './asset-cleanup.js';
import * as repository from './repository.js';
import { serializeProjectDetail } from './serializer.runtime.js';
import { createProjectService } from './service.js';
import { assertStatusTransition, bulkUpdateStatus } from './project-status.service.js';

let projectCrudService: ReturnType<typeof createProjectService> | undefined;

function service() {
	projectCrudService ??= createProjectService({
		repository,
		serializeProjectDetail,
		deleteAssetObjects,
		abortMultipart: (key, uploadId) => abortMultipartUpload(
			env().S3_BUCKET_PROTECTED,
			key,
			uploadId,
		),
		cleanupWebglEntry,
		cleanupWebglDeployment,
		logger: { error: (context, message) => logger().error(context, message) },
	});
	return projectCrudService;
}

export const projectService = {
	listProjects: (...args: Parameters<ReturnType<typeof service>['listProjects']>) => service().listProjects(...args),
	getProjectDetail: (...args: Parameters<ReturnType<typeof service>['getProjectDetail']>) => service().getProjectDetail(...args),
	updateProject: (...args: Parameters<ReturnType<typeof service>['updateProject']>) => service().updateProject(...args),
	deleteProject: (...args: Parameters<ReturnType<typeof service>['deleteProject']>) => service().deleteProject(...args),
	deleteWebgl: (...args: Parameters<ReturnType<typeof service>['deleteWebgl']>) => service().deleteWebgl(...args),
	setPoster: (...args: Parameters<ReturnType<typeof service>['setPoster']>) => service().setPoster(...args),
	bulkDeleteProjects: (...args: Parameters<ReturnType<typeof service>['bulkDeleteProjects']>) => service().bulkDeleteProjects(...args),
	assertStatusTransition,
	bulkUpdateStatus: (ids: Parameters<typeof bulkUpdateStatus>[1], status: Parameters<typeof bulkUpdateStatus>[2]) => (
		bulkUpdateStatus(repository, ids, status)
	),
};
