import { canReadVisibility } from '../../shared/visibility.js';
import { normalizeIpTarget } from '@pcu/contracts';
import { AppError, forbidden, notFound, unauthorized } from '../../shared/errors.js';
import { authorizeAssetDelivery } from './delivery-policy.js';
import { resolveDownloadRepresentation } from './download-resolver.js';
import { planAssetDeletion } from './deletion.policy.js';
import type { AssetsService, AssetsServiceDependencies } from './ports.js';

export function createAssetsService(deps: AssetsServiceDependencies): AssetsService {
	return {
		async prepareAssetDownload(assetId, variant, ip, actor, source = 'download-route') {
			const asset = await deps.repository.findAssetByIdForDownload(assetId);
			if (!asset) throw notFound('Asset not found');
			if (source === 'canonical-url' && asset.kind === 'WEBGL') variant = 'original';
			const action = variant === 'playback' ? 'DOWNLOAD_PLAYBACK' : 'DOWNLOAD_ORIGINAL';
			if (!asset.project || asset.projectId === null) {
				// Canonical URL issuance also serves exhibition posters. The GET asset
				// route retains its project-owned download contract.
				if (source !== 'canonical-url' || !asset.exhibition)
					throw new AppError(500, 'Protected asset has no project identity', 'INTERNAL_ERROR');
				if (!canReadVisibility(actor ?? null, asset.exhibition.visibility)) throw forbidden();
			} else if (!authorizeAssetDelivery({ action, asset: { ...asset, project: asset.project }, actor })) {
				if (source !== 'download-route') throw forbidden();
				if (!actor) throw unauthorized();
				throw forbidden('Not allowed to access this asset');
			}
			const representation = resolveDownloadRepresentation(asset, variant);
			const clientIp = normalizeIpTarget(ip);
			const scope = actor
				? `user:${actor.id}:${action}:${asset.id}`
				: `anonymous:${clientIp}:${action}:${asset.id}`;
			// GET asset routes historically count every download. URL issuance counts
			// protected objects only; public image URL requests retain their prior scope.
			if (source === 'download-route' || representation.bucket === deps.protectedBucket) {
				await deps.checkDownloadLimit(clientIp, scope);
			}
			return { assetId: asset.id, representation };
		},
		async deleteAsset(assetId, actor) {
			const result = await deps.deletion.run(assetId, actor, async (tx) => {
				await tx.applyDeletion(planAssetDeletion(tx.snapshot, actor));
				return { projectId: tx.snapshot.projectId };
			});
			try {
				deps.wakeDeletionWorker();
			} catch (error) {
				deps.logger.error({ error, assetId }, 'Asset deletion committed; worker wake failed');
			}
			return result;
		},
	};
}
