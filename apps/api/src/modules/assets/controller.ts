import type { FastifyPluginAsync } from 'fastify';
import { AssetDownloadQuery, parseBody, parseIntParam } from '../../shared/validation.js';
import { requireLogin } from '../../plugins/auth.js';
import type { AssetsService } from './ports.js';
import type { FileAccessService } from '../file-access/ports.js';

export interface AssetsControllerDependencies {
	service: Pick<AssetsService, 'deleteAsset'>;
	issueAssetDownload: FileAccessService['issueAssetDownload'];
}

/** Create a pure asset route plugin. Registration performs no warmup or I/O. */
export function createAssetsController(deps: AssetsControllerDependencies): FastifyPluginAsync {
	return async function assetsController(app): Promise<void> {
		/** Canonical protected capability route. Object bytes never enter Fastify. */
		app.get<{ Params: { assetId: string }; Querystring: { variant?: 'original' | 'playback' } }>(
			'/assets/:assetId/download',
			async (request, reply) => {
				const assetId = parseIntParam(request.params.assetId, 'Asset ID');
				const query = parseBody(AssetDownloadQuery, request.query);
				const grant = await deps.issueAssetDownload(assetId, query.variant ?? 'original', request);
				return reply
					.header('Referrer-Policy', 'no-referrer')
					.header('Cache-Control', 'private, no-store')
					.redirect(grant.url);
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
