import type { FastifyPluginAsync } from 'fastify';
import { requireLogin, requireRole } from '../../../shared/auth-guards.js';
import { sendCreated } from '../../../shared/http.js';
import { parseIntParam } from '../../../shared/validation.js';
import type { createProjectAccessService } from '../project-access.service.js';
import type { createProjectAssetService } from './project-asset.service.js';
import type { createSubmitProjectService } from './project-submit.service.js';
import { assertIdempotencyKey } from '../../idempotency/service.js';
import {
	limitEncodedMultipartBody,
	rethrowEncodedMultipartError,
} from '../../../shared/encoded-multipart-limit.js';

type SubmitService = ReturnType<typeof createSubmitProjectService>;
type AssetService = ReturnType<typeof createProjectAssetService>;
type ProjectAccess = ReturnType<typeof createProjectAccessService>;

interface SubmitRouteConfig {
	bodyLimit: number;
	rateLimit: {
		max: number;
		timeWindow: number;
	};
}

export function createAdminProjectSubmitController(deps: {
	service: SubmitService;
	route: SubmitRouteConfig;
}): FastifyPluginAsync {
	return async function adminProjectSubmitController(app): Promise<void> {
		app.post(
			'/projects/submit',
			{
				preHandler: requireRole('ADMIN', 'OPERATOR'),
				bodyLimit: deps.route.bodyLimit,
				handlerTimeout: 45 * 60 * 1000,
				config: { rateLimit: deps.route.rateLimit },
			},
			async (request, reply) => {
				const idempotencyKey = assertIdempotencyKey(
					request.headers['idempotency-key'],
				);
				const result = await deps.service.submitProject(
					{ actor: request.currentUser!, body: request.body, idempotencyKey },
					{ audience: 'admin' },
				);
				sendCreated(reply, result);
			},
		);
	};
}

export function createProjectAssetUploadController(deps: {
	service: AssetService;
	access: ProjectAccess;
	bodyLimit: number;
}): FastifyPluginAsync {
	return async function projectAssetUploadController(app): Promise<void> {
		app.post<{ Params: { id: string } }>(
			'/projects/:id/assets',
			{
				preHandler: requireLogin,
				preParsing: async (_request, _reply, payload) => (
					limitEncodedMultipartBody(payload, deps.bodyLimit)
				),
				bodyLimit: deps.bodyLimit,
				handlerTimeout: 45 * 60 * 1000,
			},
			async (request, reply) => {
				const idempotencyKey = assertIdempotencyKey(
					request.headers['idempotency-key'],
				);
				const projectId = parseIntParam(request.params.id);
				const actor = request.currentUser!;
				const project = await deps.access.loadProjectWithAccess(actor, projectId);
				let result;
				try {
					result = await deps.service.addAssetToProject(
						projectId,
						project.exhibitionId,
						{ actor, parts: request.parts(), idempotencyKey },
					);
				} catch (error) {
					rethrowEncodedMultipartError(request.raw, deps.bodyLimit, error);
				}
				sendCreated(reply, result);
			},
		);
	};
}

export function createAdminProjectMultipartController(deps: {
	submitController: FastifyPluginAsync;
	assetController: FastifyPluginAsync;
}): FastifyPluginAsync {
	return async function adminProjectMultipartController(app): Promise<void> {
		await app.register(deps.submitController);
		await app.register(deps.assetController);
	};
}
