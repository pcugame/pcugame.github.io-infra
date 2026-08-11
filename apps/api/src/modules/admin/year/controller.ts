import type { FastifyPluginAsync } from 'fastify';
import { sendOk, sendCreated } from '../../../shared/http.js';
import { parseBody, parseIntParam, CreateExhibitionBody, UpdateExhibitionBody } from '../../../shared/validation.js';
import { requireLogin, requireRole } from '../../../plugins/auth.js';
import type { createExhibitionService } from './service.js';

export interface YearControllerDependencies {
	service: ReturnType<typeof createExhibitionService>;
	uploadBodyLimit: number;
}

/** Register admin exhibition CRUD routes from one BackendContext-owned graph. */
export function createYearController(deps: YearControllerDependencies): FastifyPluginAsync {
	return async function yearController(app): Promise<void> {
		/** GET /exhibitions — list all exhibitions with project counts */
		app.get('/exhibitions', { preHandler: requireLogin }, async (_req, reply) => {
			const items = await deps.service.listExhibitions();
			sendOk(reply, { items });
		});

		/** POST /exhibitions — create a new exhibition */
		app.post(
			'/exhibitions',
			{ preHandler: requireRole('ADMIN', 'OPERATOR') },
			async (request, reply) => {
				const data = parseBody(CreateExhibitionBody, request.body);
				const created = await deps.service.createExhibition(data);
				sendCreated(reply, created);
			},
		);

		/** DELETE /exhibitions/:id — cascade-delete exhibition and all its projects */
		app.delete<{ Params: { id: string } }>(
			'/exhibitions/:id',
			{ preHandler: requireRole('ADMIN', 'OPERATOR') },
			async (request, reply) => {
				const id = parseIntParam(request.params.id);
				await deps.service.deleteExhibition(id);
				reply.status(204).send();
			},
		);

		/** PATCH /exhibitions/:id — partial-update exhibition settings */
		app.patch<{ Params: { id: string } }>(
			'/exhibitions/:id',
			{ preHandler: requireRole('ADMIN', 'OPERATOR') },
			async (request, reply) => {
				const id = parseIntParam(request.params.id);
				const patch = parseBody(UpdateExhibitionBody, request.body);
				const updated = await deps.service.updateExhibition(id, patch);
				sendOk(reply, updated);
			},
		);

		/** POST /exhibitions/:id/poster — upload or replace exhibition poster */
		app.post<{ Params: { id: string } }>(
			'/exhibitions/:id/poster',
			{
				preHandler: requireRole('ADMIN', 'OPERATOR'),
				bodyLimit: deps.uploadBodyLimit,
				handlerTimeout: 45 * 60 * 1000,
			},
			async (request, reply) => {
				const id = parseIntParam(request.params.id);
				const updated = await deps.service.replacePoster(id, {
					actor: request.currentUser!,
					parts: request.parts(),
				});
				sendOk(reply, updated);
			},
		);

		/** DELETE /exhibitions/:id/poster — remove exhibition poster */
		app.delete<{ Params: { id: string } }>(
			'/exhibitions/:id/poster',
			{ preHandler: requireRole('ADMIN', 'OPERATOR') },
			async (request, reply) => {
				const id = parseIntParam(request.params.id);
				await deps.service.deletePoster(id);
				reply.status(204).send();
			},
		);
	};
}
