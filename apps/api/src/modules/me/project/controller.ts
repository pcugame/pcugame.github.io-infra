import type { FastifyPluginAsync } from 'fastify';
import { requireLogin } from '../../../shared/auth-guards.js';
import { sendCreated } from '../../../shared/http.js';
import type { createSubmitProjectService } from '../../admin/project/project-submit.service.js';
import { assertIdempotencyKey } from '../../idempotency/service.js';

export function createMeProjectController(deps: {
	service: ReturnType<typeof createSubmitProjectService>;
	route: {
		bodyLimit: number;
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
				bodyLimit: deps.route.bodyLimit,
				handlerTimeout: 45 * 60 * 1000,
				config: { rateLimit: deps.route.rateLimit },
			},
			async (request, reply) => {
				const idempotencyKey = assertIdempotencyKey(
					request.headers['idempotency-key'],
				);
				const result = await deps.service.submitProject(
					{ actor: request.currentUser!, body: request.body, idempotencyKey },
					{ audience: 'user' },
				);
				sendCreated(reply, result);
			},
		);
	};
}
