import type { FastifyInstance } from 'fastify';
import { notFound } from '../../shared/errors.js';
import { parseIntParam } from '../../shared/validation.js';
import { requireLogin } from '../../plugins/auth.js';
import { loadProjectWithAccess } from '../admin/project-access.js';
import * as assetsService from './service.js';
import * as assetsRepo from './repository.js';

/** Register asset streaming and deletion routes */
export async function assetsController(app: FastifyInstance): Promise<void> {
	// Load banned IP cache on plugin registration
	await assetsService.loadBannedIpCache();

	/** GET /api/assets/public/:storageKey — stream public asset (no auth) */
	app.get<{ Params: { storageKey: string } }>(
		'/assets/public/:storageKey',
		async (request, reply) => {
			return assetsService.streamPublicAsset(request.params.storageKey, reply);
		},
	);

	/** GET /api/assets/protected/:storageKey — stream protected asset (rate-limited) */
	app.get<{ Params: { storageKey: string } }>(
		'/assets/protected/:storageKey',
		async (request, reply) => {
			return assetsService.streamProtectedAsset(request.params.storageKey, request.ip, reply);
		},
	);

	/** DELETE /api/admin/assets/:assetId — delete an asset (draft project only) */
	app.delete<{ Params: { assetId: string } }>(
		'/admin/assets/:assetId',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const assetId = parseIntParam(request.params.assetId, 'Asset ID');
			// Verify asset exists and get projectId for access check
			const asset = await assetsRepo.findAssetByIdWithProject(assetId);
			if (!asset) throw notFound('Asset not found');

			// Centralized write-access check (must be done before deletion)
			await loadProjectWithAccess(request, asset.projectId, { requireDraft: true });

			await assetsService.deleteAsset(assetId);
			reply.status(204).send();
		},
	);
}
