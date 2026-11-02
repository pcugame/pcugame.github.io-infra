import type { FastifyPluginAsync } from 'fastify';
import { requireLogin } from '../../../shared/auth-guards.js';
import { sendOk } from '../../../shared/http.js';
import { parseBody, parseIntParam, UpdateProjectBody } from '../../../shared/validation.js';
import type { ProjectUpdate } from './update.ports.js';

export function createProjectUpdateController(updateProject: ProjectUpdate): FastifyPluginAsync {
	return async app => {
		app.patch<{ Params: { id: string } }>('/projects/:id', { preHandler: requireLogin }, async (request, reply) => {
			const projectId = parseIntParam(request.params.id);
			const patch = parseBody(UpdateProjectBody, request.body);
			sendOk(reply, await updateProject(projectId, patch, request.currentUser!));
		});
	};
}
