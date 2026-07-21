import type { FastifyInstance } from 'fastify';
import { sendOk } from '../../shared/http.js';
import * as publicService from './service.js';
import * as webglService from './webgl.service.js';
import { parseIntParam } from '../../shared/validation.js';

/** Register public read-only routes (no auth required) */
export async function publicController(app: FastifyInstance): Promise<void> {
	const noGlobalCors = { cors: false } as any;
	const webglRouteOptions = { config: noGlobalCors, helmet: false } as const;
	const streamWebgl = async (
		request: { params: { projectId: string; '*': string }; headers: { range?: string } },
		reply: Parameters<typeof webglService.streamPublicWebgl>[3],
	) => webglService.streamPublicWebgl(
		parseIntParam(request.params.projectId, 'Project ID'),
		request.params['*'] || 'index.html',
		request.headers.range,
		reply,
	);

	app.options('/webgl/:projectId', webglRouteOptions, async (_request, reply) => {
		webglService.sendWebglPreflight(reply);
	});
	app.options('/webgl/:projectId/', webglRouteOptions, async (_request, reply) => {
		webglService.sendWebglPreflight(reply);
	});
	app.options('/webgl/:projectId/*', webglRouteOptions, async (_request, reply) => {
		webglService.sendWebglPreflight(reply);
	});
	app.get<{ Params: { projectId: string } }>(
		'/webgl/:projectId',
		webglRouteOptions,
		async (request, reply) => webglService.streamPublicWebgl(
			parseIntParam(request.params.projectId, 'Project ID'),
			'index.html',
			request.headers.range,
			reply,
		),
	);
	app.get<{ Params: { projectId: string } }>(
		'/webgl/:projectId/',
		webglRouteOptions,
		async (request, reply) => webglService.streamPublicWebgl(
			parseIntParam(request.params.projectId, 'Project ID'),
			'index.html',
			request.headers.range,
			reply,
		),
	);
	app.get<{ Params: { projectId: string; '*': string } }>(
		'/webgl/:projectId/*',
		webglRouteOptions,
		streamWebgl as any,
	);

	/** GET /api/public/years — list years with published project counts */
	app.get('/years', async (_request, reply) => {
		const items = await publicService.listYears();
		sendOk(reply, { items });
	});

	/** GET /api/public/exhibition-posters/:storageKey — redirect to registered exhibition poster */
	app.get<{ Params: { storageKey: string } }>(
		'/exhibition-posters/:storageKey',
		async (request, reply) => {
			const url = await publicService.getExhibitionPosterRedirectUrl(request.params.storageKey);
			reply.redirect(url);
		},
	);

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
