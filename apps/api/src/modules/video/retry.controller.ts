import type { FastifyPluginAsync } from 'fastify';
import { requireRole } from '../../plugins/auth.js';
import { sendOk } from '../../shared/http.js';
import { parseIntParam } from '../../shared/validation.js';
import type { createVideoRetryService } from './retry.service.js';

export function createVideoRetryController(service: ReturnType<typeof createVideoRetryService>): FastifyPluginAsync {
	return async (app) => {
		app.post<{ Params: { id: string; assetId: string } }>(
			'/projects/:id/videos/:assetId/retry',
			{ preHandler: requireRole('ADMIN', 'OPERATOR'), config: { rateLimit: { max: 10, timeWindow: 60000 } } },
			async (request, reply) => {
				const data = await service.retry(request.currentUser!.id, parseIntParam(request.params.id), parseIntParam(request.params.assetId));
				sendOk(reply, data, 202);
			},
		);
	};
}
