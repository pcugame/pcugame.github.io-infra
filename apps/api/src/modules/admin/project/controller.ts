import type { FastifyPluginAsync } from 'fastify';
import { sendOk } from '../../../shared/http.js';
import {
	AdminProjectListQuery,
	BulkDeleteBody,
	BulkStatusBody,
	SetPosterBody,
	UpdateProjectBody,
	parseBody,
	parseIntParam,
} from '../../../shared/validation.js';
import { requireLogin, requireRole } from '../../../plugins/auth.js';
import type { Actor } from '../../../application/http-input.js';
import type { createProjectService } from './service.js';
import type { bulkUpdateStatus } from './project-status.service.js';

type ProjectService = ReturnType<typeof createProjectService>;

export interface ProjectControllerDependencies {
	service: ProjectService;
	access: {
		loadProjectWithAccess(actor: Actor, projectId: number): Promise<{ status: string }>;
	};
	status: {
		assertTransition(currentStatus: string, targetStatus: string, role: string): void;
		bulkUpdate(ids: number[], status: Parameters<typeof bulkUpdateStatus>[2]): Promise<{ updated: number }>;
	};
}

/** Register the project CRUD routes owned by ticket 008. Multipart is separate. */
export function createProjectController(deps: ProjectControllerDependencies): FastifyPluginAsync {
	return async function projectController(app): Promise<void> {
		app.get<{ Querystring: Record<string, unknown> }>(
			'/projects',
			{ preHandler: requireLogin },
			async (request, reply) => {
				const user = request.currentUser!;
				const query = parseBody(AdminProjectListQuery, request.query);
				sendOk(reply, await deps.service.listProjects(user.id, user.role, query));
			},
		);

		app.get<{ Params: { id: string } }>(
			'/projects/:id',
			{ preHandler: requireLogin },
			async (request, reply) => {
				const user = request.currentUser!;
				const projectId = parseIntParam(request.params.id);
				sendOk(reply, await deps.service.getProjectDetail(projectId, user.id, user.role));
			},
		);

		app.patch<{ Params: { id: string } }>(
			'/projects/:id',
			{ preHandler: requireLogin },
			async (request, reply) => {
				const projectId = parseIntParam(request.params.id);
				const patch = parseBody(UpdateProjectBody, request.body);
				const user = request.currentUser!;
				const project = await deps.access.loadProjectWithAccess(user, projectId);
				if (patch.status !== undefined) {
					deps.status.assertTransition(project.status, patch.status, user.role);
				}
				sendOk(reply, await deps.service.updateProject(projectId, patch));
			},
		);

		app.delete<{ Params: { id: string } }>(
			'/projects/:id',
			{ preHandler: requireLogin },
			async (request, reply) => {
				const projectId = parseIntParam(request.params.id);
				await deps.access.loadProjectWithAccess(request.currentUser!, projectId);
				await deps.service.deleteProject(projectId);
				reply.status(204).send();
			},
		);

		app.patch(
			'/projects/bulk/status',
			{ preHandler: requireRole('ADMIN', 'OPERATOR') },
			async (request, reply) => {
				const { ids, status: next } = parseBody(BulkStatusBody, request.body);
				sendOk(reply, await deps.status.bulkUpdate(ids, next));
			},
		);

		app.post(
			'/projects/bulk/delete',
			{ preHandler: requireRole('ADMIN') },
			async (request, reply) => {
				const { ids } = parseBody(BulkDeleteBody, request.body);
				sendOk(reply, await deps.service.bulkDeleteProjects(ids));
			},
		);

		app.patch<{ Params: { id: string } }>(
			'/projects/:id/poster',
			{ preHandler: requireLogin },
			async (request, reply) => {
				const projectId = parseIntParam(request.params.id);
				await deps.access.loadProjectWithAccess(request.currentUser!, projectId);
				const { assetId } = parseBody(SetPosterBody, request.body);
				sendOk(reply, await deps.service.setPoster(projectId, assetId));
			},
		);

		app.delete<{ Params: { id: string } }>(
			'/projects/:id/webgl',
			{ preHandler: requireLogin },
			async (request, reply) => {
				const projectId = parseIntParam(request.params.id);
				await deps.access.loadProjectWithAccess(request.currentUser!, projectId);
				await deps.service.deleteWebgl(projectId);
				reply.status(204).send();
			},
		);
	};
}
