import type { FastifyPluginAsync } from 'fastify';
import { ExternalLinkSchema } from '@pcu/contracts';
import { requireLogin } from '../../shared/auth-guards.js';
import { sendOk } from '../../shared/http.js';
import { parseBody } from '../../shared/validation.js';
import { createExternalLinkService } from './service.js';

export const ResolveExternalLinkBodySchema = ExternalLinkSchema.pick({ url: true }).strict();

export function createExternalLinkController(service = createExternalLinkService()): FastifyPluginAsync {
	return async (app) => {
		app.post('/external-links/resolve', { preHandler: requireLogin }, async (request, reply) => {
			const { url } = parseBody(ResolveExternalLinkBodySchema, request.body);
			reply.header('Cache-Control', 'private, no-store');
			sendOk(reply, await service.resolve(request.currentUser!.id, url));
		});
	};
}
