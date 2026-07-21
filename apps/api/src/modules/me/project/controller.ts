import type { FastifyInstance } from 'fastify';
import { env } from '../../../config/env.js';
import { requireLogin } from '../../../plugins/auth.js';
import { sendCreated } from '../../../shared/http.js';
import { submitProject } from '../../admin/project/project-submit.runtime.js';

/** Register current-user project submission routes. */
export async function meProjectController(app: FastifyInstance): Promise<void> {
	const cfg = env();
	const uploadBodyLimit = cfg.UPLOAD_USER_REQUEST_MAX_MB * 1024 * 1024;
	const submitRouteConfig: Record<string, unknown> = {
		rateLimit: {
			max: cfg.RATE_LIMIT_SUBMIT_MAX,
			timeWindow: cfg.RATE_LIMIT_SUBMIT_WINDOW_MS,
		},
	};

	app.post(
		'/projects/submit',
		{
			preHandler: requireLogin,
			bodyLimit: uploadBodyLimit,
			config: submitRouteConfig,
		},
		async (request, reply) => {
			const result = await submitProject(
				{ actor: request.currentUser!, parts: request.parts() },
				{ audience: 'user' },
			);
			sendCreated(reply, result);
		},
	);
}
