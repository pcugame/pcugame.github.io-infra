import type { FastifyPluginAsync } from 'fastify';
import { requireLogin } from '../../../shared/auth-guards.js';
import { sendOk } from '../../../shared/http.js';
import { parseIntParam } from '../../../shared/validation.js';
import type { createWebglDisplayService } from './webgl-display.service.js';

export function createWebglDisplayController(service: ReturnType<typeof createWebglDisplayService>): FastifyPluginAsync {
	return async (app) => {
		app.get<{ Params: { id: string } }>('/projects/:id/webgl-display', { preHandler: requireLogin }, async (request, reply) => {
			sendOk(reply, await service.read(request.currentUser!, parseIntParam(request.params.id)));
		});
		app.put<{ Params: { id: string } }>('/projects/:id/webgl-display', { preHandler: requireLogin }, async (request, reply) => {
			sendOk(reply, await service.write(request.currentUser!, parseIntParam(request.params.id), request.body));
		});
	};
}
