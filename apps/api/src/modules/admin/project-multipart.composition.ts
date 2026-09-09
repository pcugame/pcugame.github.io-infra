import type { FastifyPluginAsync } from 'fastify';
import type { Env } from '../../config/env.js';
import type { createProjectAccessService } from './project-access.service.js';
import { createAdminProjectMetadataController } from './project/metadata.controller.js';
import { createSubmitProjectService } from './project/project-submit.service.js';
import type { ProjectApplicationRepository } from './project/ports.js';
import { createMeProjectController } from '../me/project/controller.js';
import { createMeRoutes } from '../me/me.routes.js';
import type { UploadLifecycleRuntime } from '../upload-lifecycle/ports.js';

type ProjectMultipartConfig = Pick<
	Env,
	| 'WEB_PUBLIC_URL'
	| 'RATE_LIMIT_SUBMIT_MAX'
	| 'RATE_LIMIT_SUBMIT_WINDOW_MS'
>;

export interface ProjectMultipartProductionGraph {
	projectMultipartController: FastifyPluginAsync;
	meController: FastifyPluginAsync;
	/** Identity seams proving ticket-008 access/repository reuse. */
	projectAccess: ReturnType<typeof createProjectAccessService>;
	projectRepository: ProjectApplicationRepository;
}

export interface ProjectMultipartProductionDependencies {
	config: ProjectMultipartConfig;
	access: ReturnType<typeof createProjectAccessService>;
	repository: ProjectApplicationRepository;
	uploadLifecycle: UploadLifecycleRuntime;
}

/** Compose metadata-only project creation; object bytes use direct sessions. */
export function createProjectMultipartProductionGraph(
	deps: ProjectMultipartProductionDependencies,
): ProjectMultipartProductionGraph {
	const submitService = createSubmitProjectService({
		webPublicUrl: deps.config.WEB_PUBLIC_URL,
		repository: deps.repository,
		idempotency: deps.uploadLifecycle.idempotency,
	});
	const route = {
		rateLimit: {
			max: deps.config.RATE_LIMIT_SUBMIT_MAX,
			timeWindow: deps.config.RATE_LIMIT_SUBMIT_WINDOW_MS,
		},
	};
	const adminSubmit = createAdminProjectMetadataController({
		service: submitService,
		route,
	});
	const meSubmit = createMeProjectController({
		service: submitService,
		route,
	});

	return {
		projectMultipartController: adminSubmit,
		meController: createMeRoutes({ projectController: meSubmit }),
		projectAccess: deps.access,
		projectRepository: deps.repository,
	};
}
