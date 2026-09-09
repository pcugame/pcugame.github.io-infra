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
	storageKey: string | null;
	playbackStorageKey: string | null;
	representations?: ReadonlyArray<{ bucket: string; objectKey: string; role: string }>;
}

export interface ProjectDeletionUpload {
	bucket?: string;
	uploadKind: string;
	s3Key: string | null;
}

export interface ProjectWebglDeploymentDeletionSnapshot {
	id: string;
	projectId: number;
	publicBucket: string;
	publicPrefix: string;
	entryObjectKey: string;
	objectManifest: unknown;
	sourceRepresentation: {
		role: string;
		bucket: string;
		objectKey: string;
	};
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
		const targets: DurableDeletionTarget[] = [
			...(asset.representations ?? []).map((representation) => ({
				bucket: representation.bucket,
				storageKey: representation.objectKey,
				reason: `${config.reason}-representation-${representation.role.toLowerCase()}`,
			})),
			...(asset.storageKey ? [{ bucket, storageKey: asset.storageKey, reason: config.reason }] : []),
			...(asset.playbackStorageKey && asset.playbackStorageKey !== asset.storageKey
				? [{
					bucket,
					storageKey: asset.playbackStorageKey,
					reason: `${config.reason}-playback`,
				}]
				: []),
			...(asset.storageKey && (asset.kind === 'IMAGE' || asset.kind === 'POSTER')
				? imageRenditionDeletionTargets(
					config.publicBucket,
					asset.storageKey,
					`${config.reason}-rendition`,
				)
				: []),
		];
		const unique = new Map(targets.map((target) => [
			`${target.bucket}\u0000${target.storageKey}`,
			target,
		]));
		return [...unique.values()];
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
			bucket: upload.bucket ?? config.protectedBucket,
			storageKey: upload.s3Key,
			reason: `${config.reason}-active-upload`,
		}];
	});
}

export function projectWebglDeletionTargets(
	projectId: number,
	webglEntryKey: string,
	config: DeletionOutboxConfig,
	deployments: readonly ProjectWebglDeploymentDeletionSnapshot[] = [],
): DurableDeletionTarget[] {
	const targets: DurableDeletionTarget[] = [];
	for (const deployment of deployments) {
		if (deployment.projectId !== projectId) {
			throw new Error(`WebGL deployment ${deployment.id} does not belong to project ${projectId}`);
		}
		if (deployment.sourceRepresentation.role !== 'WEBGL_SOURCE') {
			throw new Error(`WebGL deployment ${deployment.id} has a non-source representation`);
		}
		if (!deployment.publicPrefix.endsWith('/')
			|| !deployment.entryObjectKey.startsWith(deployment.publicPrefix)) {
			throw new Error(`WebGL deployment ${deployment.id} has an invalid public namespace`);
		}
		targets.push({
			bucket: deployment.sourceRepresentation.bucket,
			storageKey: deployment.sourceRepresentation.objectKey,
			reason: `${config.reason}-deployment-${deployment.id}-source`,
		});

		if (deployment.objectManifest == null) {
			targets.push({
				bucket: deployment.publicBucket,
				storageKey: deployment.publicPrefix,
				targetKind: 'PREFIX',
				reason: `${config.reason}-deployment-${deployment.id}-site`,
			});
			continue;
		}

		const manifest = deployment.objectManifest;
		if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
			throw new Error(`WebGL deployment ${deployment.id} has a malformed object manifest`);
		}
		const value = manifest as { version?: unknown; objects?: unknown };
		if (value.version !== 1 || !Array.isArray(value.objects)) {
			throw new Error(`WebGL deployment ${deployment.id} has a malformed object manifest`);
		}
		const keys = new Set<string>();
		for (const entry of value.objects) {
			if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
				throw new Error(`WebGL deployment ${deployment.id} has a malformed object manifest entry`);
			}
			const objectKey = (entry as { objectKey?: unknown }).objectKey;
			if (typeof objectKey !== 'string' || !objectKey.startsWith(deployment.publicPrefix)) {
				throw new Error(`WebGL deployment ${deployment.id} manifest escapes its public prefix`);
			}
			keys.add(objectKey);
		}
		if (!keys.has(deployment.entryObjectKey)) {
			throw new Error(`WebGL deployment ${deployment.id} manifest is missing its entry object`);
		}
		for (const objectKey of keys) {
			targets.push({
				bucket: deployment.publicBucket,
				storageKey: objectKey,
				targetKind: 'EXACT',
				reason: `${config.reason}-deployment-${deployment.id}-object`,
			});
		}
	}

	const legacyPointerCovered = deployments.some((deployment) => (
		webglEntryKey === deployment.entryObjectKey
		|| webglEntryKey.startsWith(deployment.publicPrefix)
	));
	if (webglEntryKey && !legacyPointerCovered) {
		targets.push(...webglDeletionTargetsByEntry(
			projectId,
			webglEntryKey,
			config,
			`${config.reason}-legacy`,
		));
	}

	const unique = new Map(targets.map((target) => [
		`${target.bucket}\u0000${target.storageKey}`,
		target,
	]));
	return [...unique.values()];
}
