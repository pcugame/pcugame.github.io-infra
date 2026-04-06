import type { FastifyInstance } from 'fastify';
import { sendOk, sendCreated } from '../../../shared/http.js';
import { parseBody, parseIntParam, CreateExhibitionBody, UpdateExhibitionBody } from '../../../shared/validation.js';
import { requireLogin, requireRole } from '../../../plugins/auth.js';
import * as exhibitionService from './service.js';

/** Register admin exhibition CRUD routes */
export async function exhibitionController(app: FastifyInstance): Promise<void> {
	/** GET /exhibitions — list all exhibitions with project counts */
	app.get('/exhibitions', { preHandler: requireLogin }, async (_req, reply) => {
		const items = await exhibitionService.listExhibitions();
		sendOk(reply, { items });
	});

	/** POST /exhibitions — create a new exhibition */
	app.post(
		'/exhibitions',
		{ preHandler: requireRole('ADMIN', 'OPERATOR') },
		async (request, reply) => {
			const data = parseBody(CreateExhibitionBody, request.body);
			const created = await exhibitionService.createExhibition(data);
			sendCreated(reply, created);
		},
	);

	/** DELETE /exhibitions/:id — cascade-delete exhibition and all its projects */
	app.delete<{ Params: { id: string } }>(
		'/exhibitions/:id',
		{ preHandler: requireRole('ADMIN', 'OPERATOR') },
		async (request, reply) => {
			const id = parseIntParam(request.params.id);
			await exhibitionService.deleteExhibition(id);
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
			const updated = await exhibitionService.updateExhibition(id, patch);
			sendOk(reply, updated);
		},
	);
}
