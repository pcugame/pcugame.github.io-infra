import type { AssetKind } from '../../../generated/prisma/client.js';
import { bucketForKind } from '../../../lib/s3.js';
import { safeDeleteObject } from '../../../lib/storage.js';

export async function deleteAssetObjects(
	asset: { id: number; projectId?: number; kind: AssetKind; storageKey: string; playbackStorageKey: string | null },
	reason: string,
) {
	const bucket = bucketForKind(asset.kind);
	await safeDeleteObject(bucket, asset.storageKey, reason, { assetId: asset.id, projectId: asset.projectId });
	if (asset.playbackStorageKey && asset.playbackStorageKey !== asset.storageKey) {
		await safeDeleteObject(bucket, asset.playbackStorageKey, `${reason}-playback`, { assetId: asset.id, projectId: asset.projectId });
	}
}
