import type { FastifyPluginAsync } from 'fastify';
import { requireLogin } from '../../../shared/auth-guards.js';
import { sendCreated, sendOk } from '../../../shared/http.js';
import { parseIntParam } from '../../../shared/validation.js';
import type { createSubmitProjectService } from '../../admin/project/project-submit.service.js';
import { assertIdempotencyKey } from '../../idempotency/service.js';
import { readMetadataPayload } from '../../admin/project/metadata-payload.js';

export function createMeProjectController(deps: {
	service: ReturnType<typeof createSubmitProjectService>;
	route: {
		rateLimit: {
			max: number;
			timeWindow: number;
		};
	};
}): FastifyPluginAsync {
	return async function meProjectController(app): Promise<void> {
		app.post(
			'/projects/submit',
			{
				preHandler: requireLogin,
				config: { rateLimit: deps.route.rateLimit },
			},
			async (request, reply) => {
				const idempotencyKey = assertIdempotencyKey(
					request.headers['idempotency-key'],
				);
				const result = await deps.service.submitProject(
					{ actor: request.currentUser!, payload: await readMetadataPayload(request.parts() as AsyncIterable<never>), idempotencyKey },
					{ audience: 'user' },
				);
				sendCreated(reply, result);
			},
		);
		app.get<{ Params: { id: string } }>('/projects/:id/submission', { preHandler: requireLogin }, async (request, reply) => {
			sendOk(reply, await deps.service.status(request.currentUser!, parseIntParam(request.params.id)));
		});
		app.post<{ Params: { id: string } }>('/projects/:id/submission/finalize', {
			preHandler: requireLogin,
			config: { rateLimit: deps.route.rateLimit },
		}, async (request, reply) => {
			sendOk(reply, await deps.service.finalize(request.currentUser!, parseIntParam(request.params.id)));
		});
		app.delete<{ Params: { id: string } }>('/projects/:id/submission', { preHandler: requireLogin }, async (request, reply) => {
			sendOk(reply, await deps.service.cancel(request.currentUser!, parseIntParam(request.params.id)));
		});
	};
}
