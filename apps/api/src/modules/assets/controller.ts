import type { FastifyInstance } from 'fastify';
import { parseIntParam } from '../../shared/validation.js';
import { requireLogin } from '../../plugins/auth.js';
import { assetsService } from './runtime.js';
import { applyResponseDescriptor } from '../../shared/response-descriptor.js';

/** Register asset streaming and deletion routes */
export async function assetsController(app: FastifyInstance): Promise<void> {
	// Load banned IP cache on plugin registration
	await assetsService.loadBannedIpCache();

	/** GET /api/assets/public/:storageKey — stream public asset (no auth) */
	app.get<{ Params: { storageKey: string } }>(
		'/assets/public/:storageKey',
		async (request, reply) => {
			return applyResponseDescriptor(
				reply,
				await assetsService.streamPublicAsset(request.params.storageKey),
			);
		},
	);

	/** GET /api/assets/protected/:storageKey — stream protected asset (rate-limited) */
	app.get<{ Params: { storageKey: string } }>(
		'/assets/protected/:storageKey',
		async (request, reply) => {
			return applyResponseDescriptor(
				reply,
				await assetsService.streamProtectedAsset(
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
			await assetsService.deleteAsset(assetId, request.currentUser!);
			reply.status(204).send();
		},
	);
}
