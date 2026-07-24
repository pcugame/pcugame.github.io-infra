import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../../config/env.js';
import { sendCreated } from '../../../shared/http.js';
import { parseIntParam } from '../../../shared/validation.js';
import { requireLogin, requireRole } from '../../../plugins/auth.js';
import { loadProjectWithAccess } from '../project-access.runtime.js';
import { addAssetToProject } from './project-asset.runtime.js';
import { submitProject } from './project-submit.runtime.js';

/**
 * Temporary ticket-011 compatibility plugin. It deliberately keeps the old
 * multipart runtime/env graph out of the ticket-008 CRUD controller.
 */
export const projectMultipartCompatibilityController: FastifyPluginAsync = async (app) => {
	const uploadBodyLimit = env().UPLOAD_PRIVILEGED_REQUEST_MAX_MB * 1024 * 1024;
	app.post(
		'/projects/submit',
		{
			preHandler: requireRole('ADMIN', 'OPERATOR'),
			bodyLimit: uploadBodyLimit,
			config: {
				rateLimit: {
					max: env().RATE_LIMIT_SUBMIT_MAX,
					timeWindow: env().RATE_LIMIT_SUBMIT_WINDOW_MS,
				},
			},
		},
		async (request, reply) => {
			const result = await submitProject(
				{ actor: request.currentUser!, parts: request.parts() },
				{ audience: 'admin' },
			);
			sendCreated(reply, result);
		},
	);

	app.post<{ Params: { id: string } }>(
		'/projects/:id/assets',
		{ preHandler: requireLogin, bodyLimit: uploadBodyLimit },
		async (request, reply) => {
			const projectId = parseIntParam(request.params.id);
			const user = request.currentUser!;
			const project = await loadProjectWithAccess(user, projectId);
			const result = await addAssetToProject(
				projectId,
				project.exhibitionId,
				{ actor: user, parts: request.parts() },
			);
			sendCreated(reply, result);
		},
	);
};
