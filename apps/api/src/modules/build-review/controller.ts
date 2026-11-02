import type { FastifyPluginAsync } from 'fastify';
import { BuildReviewDecisionSchema } from '@pcu/contracts';
import { requireRole } from '../../plugins/auth.js';
import { sendOk } from '../../shared/http.js';
import type { createBuildReviewService } from './service.js';
export function createBuildReviewController(
	service: ReturnType<typeof createBuildReviewService>,
): FastifyPluginAsync {
	return async (app) => {
		const preHandler = requireRole('ADMIN', 'OPERATOR');
		app.get<{ Querystring: { projectId?: number } }>(
			'/build-reviews',
			{ preHandler },
			async (request, reply) =>
				sendOk(reply, await service.list(request.currentUser!.id, request.query.projectId)),
		);
		app.get<{ Params: { id: string } }>('/build-reviews/:id', { preHandler }, async (request, reply) =>
			sendOk(reply, await service.detail(request.currentUser!.id, request.params.id)),
		);
		app.post<{ Params: { id: string } }>(
			'/build-reviews/:id/decision',
			{ preHandler },
			async (request, reply) =>
				sendOk(
					reply,
					await service.decide(
						request.currentUser!.id,
						request.params.id,
						BuildReviewDecisionSchema.parse(request.body),
					),
				),
		);
	};
}
