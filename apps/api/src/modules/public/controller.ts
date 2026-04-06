import type { FastifyInstance } from 'fastify';
import { sendOk } from '../../shared/http.js';
import * as publicService from './service.js';

/** Register public read-only routes (no auth required) */
export async function publicController(app: FastifyInstance): Promise<void> {
	/** GET /api/public/years — list years with published project counts */
	app.get('/years', async (_request, reply) => {
		const items = await publicService.listYears();
		sendOk(reply, { items });
	});

	/** GET /api/public/years/:year/projects — list projects in a year */
	app.get<{ Params: { year: string } }>(
		'/years/:year/projects',
		async (request, reply) => {
			const data = await publicService.listProjectsByYear(request.params.year);
			sendOk(reply, data);
		},
	);

	/** GET /api/public/exhibitions/:id/projects — list projects in a single exhibition */
	app.get<{ Params: { id: string } }>(
		'/exhibitions/:id/projects',
		async (request, reply) => {
			const data = await publicService.listProjectsByExhibition(request.params.id);
			sendOk(reply, data);
		},
	);

	/** GET /api/public/projects/:idOrSlug — get project detail by ID or slug */
	app.get<{
		Params: { idOrSlug: string };
		Querystring: { year?: string };
	}>('/projects/:idOrSlug', async (request, reply) => {
		const data = await publicService.getProjectDetail(
			request.params.idOrSlug,
			request.query.year,
		);
		sendOk(reply, data);
	});
}
