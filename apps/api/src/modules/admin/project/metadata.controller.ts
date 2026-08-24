import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../../../shared/auth-guards.js';
import { sendCreated, sendOk } from '../../../shared/http.js';
import { parseIntParam } from '../../../shared/validation.js';
import { assertIdempotencyKey } from '../../idempotency/service.js';
import { readMetadataPayload } from './metadata-payload.js';
import type { createSubmitProjectService } from './project-submit.service.js';

type SubmitService = ReturnType<typeof createSubmitProjectService>;

export function createAdminProjectMetadataController(deps: {
	service: SubmitService;
	route: { rateLimit: { max: number; timeWindow: number } };
}): FastifyPluginAsync {
	return async function adminProjectMetadataController(app): Promise<void> {
		app.get('/project-submissions/audit', {
			preHandler: requireRole('ADMIN'),
		}, async (_request, reply) => {
			sendOk(reply, await deps.service.audit());
		});
		app.post('/projects/submit', {
			preHandler: requireRole('ADMIN', 'OPERATOR'),
			config: { rateLimit: deps.route.rateLimit },
		}, async (request, reply) => {
			const result = await deps.service.submitProject({
				actor: request.currentUser!,
				payload: await readMetadataPayload(request.parts() as AsyncIterable<never>),
				idempotencyKey: assertIdempotencyKey(request.headers['idempotency-key']),
			}, { audience: 'admin' });
			sendCreated(reply, result);
		});
		app.get<{ Params: { id: string } }>('/projects/:id/submission', {
			preHandler: requireRole('ADMIN', 'OPERATOR'),
		}, async (request, reply) => {
			sendOk(reply, await deps.service.status(request.currentUser!, parseIntParam(request.params.id)));
		});
		app.post<{ Params: { id: string } }>('/projects/:id/submission/finalize', {
			preHandler: requireRole('ADMIN', 'OPERATOR'),
			config: { rateLimit: deps.route.rateLimit },
		}, async (request, reply) => {
			sendOk(reply, await deps.service.finalize(request.currentUser!, parseIntParam(request.params.id)));
		});
		app.delete<{ Params: { id: string } }>('/projects/:id/submission', {
			preHandler: requireRole('ADMIN', 'OPERATOR'),
		}, async (request, reply) => {
			sendOk(reply, await deps.service.cancel(request.currentUser!, parseIntParam(request.params.id)));
		});
	};
}
