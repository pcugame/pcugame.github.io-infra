import type { FastifyPluginAsync } from 'fastify';
import { sendOk } from '../../shared/http.js';
import type { createPublicService } from './service.js';

export interface PublicControllerDependencies {
	service: ReturnType<typeof createPublicService>;
}

/** Create the public read-only route plugin without capturing process state. */
export function createPublicController(deps: PublicControllerDependencies): FastifyPluginAsync {
	return async function publicController(app): Promise<void> {
		app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'private, no-store'); });
		app.get('/upload-config', async (_request, reply) => {
			sendOk(reply, { materialMaxCount: 5, materialMaxBytes: 50 * 1024 * 1024 });
		});
		/** GET /api/public/years — list years with published project counts */
		app.get('/years', async (request, reply) => {
			const items = await deps.service.listYears(request.currentUser ?? null);
			sendOk(reply, { items });
		});

		/** GET /api/public/years/:year/projects — list projects in a year */
		app.get<{ Params: { year: string } }>(
			'/years/:year/projects',
			async (request, reply) => {
				const data = await deps.service.listProjectsByYear(request.params.year, request.currentUser ?? null);
				sendOk(reply, data);
			},
		);

		/** GET /api/public/exhibitions/:id/projects — list projects in a single exhibition */
		app.get<{ Params: { id: string } }>(
			'/exhibitions/:id/projects',
			async (request, reply) => {
				const data = await deps.service.listProjectsByExhibition(request.params.id, request.currentUser ?? null);
				sendOk(reply, data);
			},
		);

		/** GET /api/public/projects/:idOrSlug — get project detail by ID or slug */
		app.get<{
			Params: { idOrSlug: string };
			Querystring: { year?: string };
		}>('/projects/:idOrSlug', async (request, reply) => {
			const data = await deps.service.getProjectDetail(
				request.params.idOrSlug,
				request.query.year,
				request.currentUser ?? null,
			);
			sendOk(reply, data);
		});
	};
}
