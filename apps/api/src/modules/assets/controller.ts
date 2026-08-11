import type { FastifyPluginAsync } from 'fastify';
import { parseIntParam } from '../../shared/validation.js';
import { requireLogin } from '../../plugins/auth.js';
import { applyResponseDescriptor } from '../../shared/response-descriptor.js';
import type { createAssetsService } from './service.js';

export interface AssetsControllerDependencies {
	service: ReturnType<typeof createAssetsService>;
}

/** Create a pure asset route plugin. Registration performs no warmup or I/O. */
export function createAssetsController(deps: AssetsControllerDependencies): FastifyPluginAsync {
	return async function assetsController(app): Promise<void> {
		/** GET /api/assets/public/:storageKey — stream public asset (no auth) */
		app.get<{ Params: { storageKey: string } }>(
			'/assets/public/:storageKey',
			async (request, reply) => {
				return applyResponseDescriptor(
					reply,
					await deps.service.streamPublicAsset(request.params.storageKey),
				);
			},
		);

		/** GET /api/assets/protected/:storageKey — stream protected asset (rate-limited) */
		app.get<{ Params: { storageKey: string } }>(
			'/assets/protected/:storageKey',
			async (request, reply) => {
				return applyResponseDescriptor(
					reply,
					await deps.service.streamProtectedAsset(
						request.params.storageKey,
						request.ip,
						request.currentUser,
					),
				);
			},
		);

		/** DELETE /api/admin/assets/:assetId — delete an asset */
		app.delete<{ Params: { assetId: string } }>(
			'/admin/assets/:assetId',
			{ preHandler: requireLogin },
			async (request, reply) => {
				const assetId = parseIntParam(request.params.assetId, 'Asset ID');
				await deps.service.deleteAsset(assetId, request.currentUser!);
				reply.status(204).send();
			},
		);
	};
}
