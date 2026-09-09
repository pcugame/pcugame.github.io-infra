import type { FastifyPluginAsync } from 'fastify';
import { sendOk } from '../../shared/http.js';
import { parseIntParam } from '../../shared/validation.js';
import { applyResponseDescriptor } from '../../shared/response-descriptor.js';
import type { createPublicService } from './service.js';
import type { createPublicDeliveryBridgeService } from './delivery-bridge.service.js';

export interface PublicControllerDependencies {
	service: ReturnType<typeof createPublicService>;
	deliveryBridge: ReturnType<typeof createPublicDeliveryBridgeService>;
}

/** Create the public read-only route plugin without capturing process state. */
export function createPublicController(deps: PublicControllerDependencies): FastifyPluginAsync {
	return async function publicController(app): Promise<void> {
		app.get('/upload-config', async (_request, reply) => {
			sendOk(reply, { materialMaxCount: 5, materialMaxBytes: 50 * 1024 * 1024 });
		});
		const webglHandler = async (
			projectId: string,
			requestedPath: string,
			reply: Parameters<typeof applyResponseDescriptor>[0],
			rawUrl?: string,
		) => applyResponseDescriptor(
			reply,
			await deps.deliveryBridge.webgl(
				parseIntParam(projectId, 'Project ID'),
				requestedPath,
				rawUrl,
			),
		);
		const webglRouteOptions = { exposeHeadRoute: false } as const;

		app.get<{ Params: { projectId: string } }>(
			'/webgl/:projectId',
			webglRouteOptions,
			async (request, reply) => webglHandler(request.params.projectId, 'index.html', reply, request.raw.url),
		);
		app.head<{ Params: { projectId: string } }>(
			'/webgl/:projectId',
			async (request, reply) => webglHandler(request.params.projectId, 'index.html', reply, request.raw.url),
		);
		app.get<{ Params: { projectId: string } }>(
			'/webgl/:projectId/',
			webglRouteOptions,
			async (request, reply) => webglHandler(request.params.projectId, 'index.html', reply, request.raw.url),
		);
		app.head<{ Params: { projectId: string } }>(
			'/webgl/:projectId/',
			async (request, reply) => webglHandler(request.params.projectId, 'index.html', reply, request.raw.url),
		);
		app.get<{ Params: { projectId: string; '*': string } }>(
			'/webgl/:projectId/*',
			webglRouteOptions,
			async (request, reply) => webglHandler(
				request.params.projectId, request.params['*'] || 'index.html', reply, request.raw.url,
			),
		);
		app.head<{ Params: { projectId: string; '*': string } }>(
			'/webgl/:projectId/*',
			async (request, reply) => webglHandler(
				request.params.projectId, request.params['*'] || 'index.html', reply, request.raw.url,
			),
		);

		const imageHandler = async (storageKey: string, reply: Parameters<typeof applyResponseDescriptor>[0]) => (
			applyResponseDescriptor(reply, await deps.deliveryBridge.image(storageKey))
		);
		for (const prefix of ['/images/*', '/assets/*'] as const) {
			app.get<{ Params: { '*': string } }>(prefix, { exposeHeadRoute: false }, async (request, reply) => (
				imageHandler(request.params['*'], reply)
			));
			app.head<{ Params: { '*': string } }>(prefix, async (request, reply) => (
				imageHandler(request.params['*'], reply)
			));
		}

		/** GET /api/public/years — list years with published project counts */
		app.get('/years', async (_request, reply) => {
			const items = await deps.service.listYears();
			sendOk(reply, { items });
		});

		/** GET /api/public/years/:year/projects — list projects in a year */
		app.get<{ Params: { year: string } }>(
			'/years/:year/projects',
			async (request, reply) => {
				const data = await deps.service.listProjectsByYear(request.params.year);
				sendOk(reply, data);
			},
		);

		/** GET /api/public/exhibitions/:id/projects — list projects in a single exhibition */
		app.get<{ Params: { id: string } }>(
			'/exhibitions/:id/projects',
			async (request, reply) => {
				const data = await deps.service.listProjectsByExhibition(request.params.id);
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
			);
			sendOk(reply, data);
		});
	};
}
