import type { AssetKind } from '@pcu/contracts';
import type { SavedUpload } from '../../../application/upload-ports.js';
import { bucketForKind } from '../../../lib/s3.js';
import { deleteDurablyQueuedObject, safeDeleteObject } from '../../../object-deletion.js';

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

/** Best-effort cleanup for objects already protected by a transactional orphan outbox row. */
export async function deleteDurablyQueuedAssetObjects(
	asset: { id: number; projectId?: number; kind: AssetKind; storageKey: string; playbackStorageKey: string | null },
	reason: string,
) {
	const bucket = bucketForKind(asset.kind);
	await deleteDurablyQueuedObject(bucket, asset.storageKey, reason, { assetId: asset.id, projectId: asset.projectId });
	if (asset.playbackStorageKey && asset.playbackStorageKey !== asset.storageKey) {
		await deleteDurablyQueuedObject(bucket, asset.playbackStorageKey, `${reason}-playback`, {
			assetId: asset.id,
			projectId: asset.projectId,
		});
	}
}

/** Cleanup for an upload whose DB write never committed; no outbox exists yet. */
export async function deleteUnpersistedAssetUpload(upload: SavedUpload) {
	const bucket = bucketForKind(upload.kind);
	await safeDeleteObject(bucket, upload.storageKey, 'project-asset-upload-loser', {
		kind: upload.kind,
	});
	if (upload.playbackStorageKey && upload.playbackStorageKey !== upload.storageKey) {
		await safeDeleteObject(
			bucket,
			upload.playbackStorageKey,
			'project-asset-upload-loser-playback',
			{ kind: upload.kind },
		);
	}
}
