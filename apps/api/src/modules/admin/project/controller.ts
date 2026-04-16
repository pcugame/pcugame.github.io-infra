import type { FastifyInstance } from 'fastify';
import { env } from '../../../config/env.js';
import { sendOk, sendCreated } from '../../../shared/http.js';
import { parseBody, parseIntParam, UpdateProjectBody, SetPosterBody, BulkStatusBody, BulkDeleteBody } from '../../../shared/validation.js';
import { requireLogin, requireRole } from '../../../plugins/auth.js';
import { loadProjectWithAccess } from '../project-access.js';
import { assertUploadAllowed } from '../upload-guard.js';
import * as projectService from './service.js';
import * as repo from './repository.js';

/** Register admin project CRUD + upload routes */
export async function projectController(app: FastifyInstance): Promise<void> {
	/** GET /projects — list user's projects */
	app.get('/projects', { preHandler: requireLogin }, async (request, reply) => {
		const user = request.currentUser!;
		const items = await projectService.listProjects(user.id, user.role);
		sendOk(reply, { items });
	});

	/** GET /projects/:id — get project detail */
	app.get<{ Params: { id: string } }>(
		'/projects/:id',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const user = request.currentUser!;
			const projectId = parseIntParam(request.params.id);
			const data = await projectService.getProjectDetail(projectId, user.id, user.role);
			sendOk(reply, data);
		},
	);

	/** PATCH /projects/:id — partial-update project */
	app.patch<{ Params: { id: string } }>(
		'/projects/:id',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const projectId = parseIntParam(request.params.id);
			const patch = parseBody(UpdateProjectBody, request.body);
			const user = request.currentUser!;

			// Status changes need special handling: USER can toggle DRAFT ↔ PUBLISHED
			// on their own projects even when the project is not in DRAFT.
			const isStatusChange = patch.status !== undefined;
			const project = await loadProjectWithAccess(request, projectId, {
				requireDraft: !isStatusChange,
			});

			if (isStatusChange) {
				projectService.assertStatusTransition(project.status, patch.status!, user.role);
			}

			const updated = await projectService.updateProject(projectId, patch);
			sendOk(reply, updated);
		},
	);

	/** DELETE /projects/:id — delete project and associated files (draft only) */
	app.delete<{ Params: { id: string } }>(
		'/projects/:id',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const projectId = parseIntParam(request.params.id);
			await loadProjectWithAccess(request, projectId, { requireDraft: true });
			await projectService.deleteProject(projectId);
			reply.status(204).send();
		},
	);

	/** PATCH /projects/bulk/status — bulk update project status (ADMIN/OPERATOR) */
	app.patch(
		'/projects/bulk/status',
		{ preHandler: requireRole('OPERATOR') },
		async (request, reply) => {
			const { ids, status } = parseBody(BulkStatusBody, request.body);
			const result = await projectService.bulkUpdateStatus(ids, status);
			sendOk(reply, result);
		},
	);

	/** POST /projects/bulk/delete — bulk delete projects (ADMIN only) */
	app.post(
		'/projects/bulk/delete',
		{ preHandler: requireRole('ADMIN') },
		async (request, reply) => {
			const { ids } = parseBody(BulkDeleteBody, request.body);
			const result = await projectService.bulkDeleteProjects(ids);
			sendOk(reply, result);
		},
	);

	/** POST /projects/submit — create project with multipart file upload */
	const uploadBodyLimit = env().UPLOAD_PRIVILEGED_REQUEST_MAX_MB * 1024 * 1024;
	app.post(
		'/projects/submit',
		{ preHandler: requireLogin, bodyLimit: uploadBodyLimit },
		async (request, reply) => {
			const result = await projectService.submitProject(request as any);
			sendCreated(reply, result);
		},
	);

	/** POST /projects/:id/assets — add single asset to project (draft only) */
	app.post<{ Params: { id: string } }>(
		'/projects/:id/assets',
		{ preHandler: requireLogin, bodyLimit: uploadBodyLimit },
		async (request, reply) => {
			const projectId = parseIntParam(request.params.id);
			const project = await loadProjectWithAccess(request, projectId, { requireDraft: true });
			const user = request.currentUser!;
			const exhibition = await repo.findExhibitionById(project.exhibitionId);
			assertUploadAllowed(exhibition, project.exhibitionId, user.role);
			const result = await projectService.addAssetToProject(projectId, request as any);
			sendCreated(reply, result);
		},
	);

	/** PATCH /projects/:id/poster — set poster asset for project (draft only) */
	app.patch<{ Params: { id: string } }>(
		'/projects/:id/poster',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const projectId = parseIntParam(request.params.id);
			await loadProjectWithAccess(request, projectId, { requireDraft: true });
			const { assetId } = parseBody(SetPosterBody, request.body);
			const result = await projectService.setPoster(projectId, assetId);
			sendOk(reply, result);
		},
	);
}
