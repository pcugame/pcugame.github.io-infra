import type { AssetKind } from '../../../generated/prisma/client.js';
import type { DurableDeletionTarget } from '../../orphan/outbox.js';
import { imageRenditionDeletionTargets } from '../../assets/image-rendition-lifecycle.js';
import {
	webglDeletionTargetsByEntry,
	webglDeletionTargetsBySource,
} from '../../webgl/deletion-targets.js';
import type { DeletionOutboxConfig } from './ports.js';

export interface ProjectDeletionAsset {
	kind: AssetKind;
	storageKey: string;
	playbackStorageKey: string | null;
}

export interface ProjectDeletionUpload {
	uploadKind: string;
	s3Key: string | null;
}

function assetBucket(kind: AssetKind, config: DeletionOutboxConfig): string {
	return kind === 'GAME' || kind === 'VIDEO'
		? config.protectedBucket
		: config.publicBucket;
}

export function projectAssetDeletionTargets(
	assets: readonly ProjectDeletionAsset[],
	config: DeletionOutboxConfig,
): DurableDeletionTarget[] {
	return assets.flatMap((asset) => {
		const bucket = assetBucket(asset.kind, config);
		return [
			{ bucket, storageKey: asset.storageKey, reason: config.reason },
			...(asset.playbackStorageKey && asset.playbackStorageKey !== asset.storageKey
				? [{
					bucket,
					storageKey: asset.playbackStorageKey,
					reason: `${config.reason}-playback`,
				}]
				: []),
			...(asset.kind === 'IMAGE' || asset.kind === 'POSTER'
				? imageRenditionDeletionTargets(
					config.publicBucket,
					asset.storageKey,
					`${config.reason}-rendition`,
				)
				: []),
		];
	});
}

export function projectActiveUploadDeletionTargets(
	projectId: number,
	uploads: readonly ProjectDeletionUpload[],
	config: DeletionOutboxConfig,
): DurableDeletionTarget[] {
	return uploads.flatMap((upload) => {
		if (!upload.s3Key) return [];
		if (upload.uploadKind === 'WEBGL') {
			return webglDeletionTargetsBySource(
				projectId,
				upload.s3Key,
				config,
				`${config.reason}-active-upload`,
			);
		}
		return [{
			bucket: config.protectedBucket,
			storageKey: upload.s3Key,
			reason: `${config.reason}-active-upload`,
		}];
	});
}

export function projectWebglDeletionTargets(
	projectId: number,
	webglEntryKey: string,
	config: DeletionOutboxConfig,
): DurableDeletionTarget[] {
	return webglDeletionTargetsByEntry(
		projectId,
		webglEntryKey,
		config,
		config.reason,
	);
}
