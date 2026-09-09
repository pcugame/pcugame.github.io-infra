import type { FastifyPluginAsync } from 'fastify';
import { requireLogin, requireRole } from '../../shared/auth-guards.js';
import { sendCreated, sendOk } from '../../shared/http.js';
import { parseIntParam } from '../../shared/validation.js';
import type { ChangeListOptions } from './ports.js';
import type { createProjectChangeService } from './service.js';

export function createProjectChangeController(service: ReturnType<typeof createProjectChangeService>, audience: 'me' | 'admin'): FastifyPluginAsync {
	return async (app) => {
		const guard = audience === 'admin' ? requireRole('ADMIN', 'OPERATOR') : requireLogin;
		app.get<{ Querystring: ChangeListOptions }>('/change-requests', { preHandler: guard }, async (request, reply) => {
			sendOk(reply, await service.list(request.currentUser!, request.query));
		});
		app.get<{ Params: { id: string } }>('/change-requests/:id', { preHandler: guard }, async (request, reply) => {
			sendOk(reply, await service.detail(request.currentUser!, request.params.id));
		});
		if (audience === 'me') {
			app.get<{ Params: { id: string }; Querystring: ChangeListOptions }>('/projects/:id/change-requests', { preHandler: guard }, async (request, reply) => {
				sendOk(reply, await service.list(request.currentUser!, { ...request.query, projectId: parseIntParam(request.params.id) }));
			});
			app.post<{ Params: { id: string } }>('/projects/:id/change-requests', { preHandler: guard }, async (request, reply) => {
				sendCreated(reply, await service.create(request.currentUser!, parseIntParam(request.params.id), request.body));
			});
			app.patch<{ Params: { id: string } }>('/change-requests/:id', { preHandler: guard }, async (request, reply) => {
				sendOk(reply, await service.update(request.currentUser!, request.params.id, request.body));
			});
			for (const action of ['submit', 'cancel'] as const) {
				app.post<{ Params: { id: string } }>(`/change-requests/:id/${action}`, { preHandler: guard }, async (request, reply) => {
					sendOk(reply, await service[action](request.currentUser!, request.params.id));
				});
			}
		} else {
			for (const action of ['approve', 'retry'] as const) {
				app.post<{ Params: { id: string } }>(`/change-requests/:id/${action}`, { preHandler: guard }, async (request, reply) => {
					sendOk(reply, await service[action](request.currentUser!, request.params.id));
				});
			}
			app.post<{ Params: { id: string }; Body: { reason: string } }>('/change-requests/:id/reject', { preHandler: guard }, async (request, reply) => {
				sendOk(reply, await service.reject(request.currentUser!, request.params.id, request.body.reason));
			});
		}
	};
}
