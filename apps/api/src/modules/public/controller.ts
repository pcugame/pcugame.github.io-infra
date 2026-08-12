import type { FastifyPluginAsync } from 'fastify';
import { sendOk } from '../../shared/http.js';
import { parseIntParam } from '../../shared/validation.js';
import { applyDescriptorHeaders, applyResponseDescriptor } from '../../shared/response-descriptor.js';
import type { createPublicService } from './service.js';
import type { createPublicImageService } from './image.service.js';
import type { createPublicWebglService } from './webgl.service.js';

export interface PublicControllerDependencies {
	service: ReturnType<typeof createPublicService>;
	imageService: ReturnType<typeof createPublicImageService>;
	webglService: ReturnType<typeof createPublicWebglService>;
}

/** Create the public read-only route plugin without capturing process state. */
export function createPublicController(deps: PublicControllerDependencies): FastifyPluginAsync {
	return async function publicController(app): Promise<void> {
		const noGlobalCors = { cors: false };
		const webglRouteOptions = { config: noGlobalCors, helmet: false } as const;

		app.options('/webgl/:projectId', webglRouteOptions, async (_request, reply) => {
			return applyResponseDescriptor(reply, deps.webglService.preflight());
		});
		app.options('/webgl/:projectId/', webglRouteOptions, async (_request, reply) => {
			return applyResponseDescriptor(reply, deps.webglService.preflight());
		});
		app.options('/webgl/:projectId/*', webglRouteOptions, async (_request, reply) => {
			return applyResponseDescriptor(reply, deps.webglService.preflight());
		});
		app.get<{ Params: { projectId: string } }>(
			'/webgl/:projectId',
			webglRouteOptions,
			async (request, reply) => {
				applyDescriptorHeaders(reply, deps.webglService.securityHeaders());
				return applyResponseDescriptor(reply, await deps.webglService.stream(
					parseIntParam(request.params.projectId, 'Project ID'),
					'index.html',
					request.headers.range,
				));
			},
		);
		app.get<{ Params: { projectId: string } }>(
			'/webgl/:projectId/',
			webglRouteOptions,
			async (request, reply) => {
				applyDescriptorHeaders(reply, deps.webglService.securityHeaders());
				return applyResponseDescriptor(reply, await deps.webglService.stream(
					parseIntParam(request.params.projectId, 'Project ID'),
					'index.html',
					request.headers.range,
				));
			},
		);
		app.get<{ Params: { projectId: string; '*': string } }>(
			'/webgl/:projectId/*',
			webglRouteOptions,
			async (request, reply) => {
				applyDescriptorHeaders(reply, deps.webglService.securityHeaders());
				return applyResponseDescriptor(reply, await deps.webglService.stream(
					parseIntParam(request.params.projectId, 'Project ID'),
					request.params['*'] || 'index.html',
					request.headers.range,
					request.raw.url,
				));
			},
		);

		const imageHandler = async (
			method: 'GET' | 'HEAD',
			storageKey: string,
			headers: { 'if-none-match'?: string; 'if-modified-since'?: string },
			reply: Parameters<typeof applyResponseDescriptor>[0],
		) => applyResponseDescriptor(
			reply,
			await deps.imageService[method === 'GET' ? 'get' : 'head'](storageKey, {
				ifNoneMatch: headers['if-none-match'],
				ifModifiedSince: headers['if-modified-since'],
			}),
		);

		/** Explicit GET and HEAD avoid Fastify opening a body stream for HEAD. */
		app.get<{
			Params: { storageKey: string };
			Headers: { 'if-none-match'?: string; 'if-modified-since'?: string };
		}>(
			'/images/:storageKey',
			{ exposeHeadRoute: false },
			async (request, reply) => imageHandler(
				'GET',
				request.params.storageKey,
				request.headers,
				reply,
			),
		);
		app.head<{
			Params: { storageKey: string };
			Headers: { 'if-none-match'?: string; 'if-modified-since'?: string };
		}>(
			'/images/:storageKey',
			async (request, reply) => imageHandler(
				'HEAD',
				request.params.storageKey,
				request.headers,
				reply,
			),
		);

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
