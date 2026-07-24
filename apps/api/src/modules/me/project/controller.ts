import type { FastifyPluginAsync } from 'fastify';
import { requireLogin } from '../../../shared/auth-guards.js';
import { sendCreated } from '../../../shared/http.js';
import type { createSubmitProjectService } from '../../admin/project/project-submit.service.js';

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
				config: { rateLimit: deps.route.rateLimit },
			},
			async (request, reply) => {
				const result = await deps.service.submitProject(
					{ actor: request.currentUser!, parts: request.parts() },
					{ audience: 'user' },
				);
				sendCreated(reply, result);
			},
		);
	};
}
