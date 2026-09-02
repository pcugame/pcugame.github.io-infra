import type { DurableDeletionTarget } from '../../orphan/outbox.js';
import type { DeletionOutboxConfig } from './ports.js';

export interface ProjectDeletionAsset {
	representations: ReadonlyArray<{
		bucket: string;
		objectKey: string;
		role: string;
		publicationBucket?: string | null;
		publicationObjectKey?: string | null;
	}>;
}

export interface ProjectDeletionUpload {
	uploadKind: string;
	objectKey: string;
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

export function projectAssetDeletionTargets(
	assets: readonly ProjectDeletionAsset[],
	config: DeletionOutboxConfig,
): DurableDeletionTarget[] {
	return assets.flatMap((asset) => {
	const targets: DurableDeletionTarget[] = asset.representations.map((representation) => ({
				bucket: representation.bucket,
				storageKey: representation.objectKey,
				reason: `${config.reason}-representation-${representation.role.toLowerCase()}`,
			}));
		for (const representation of asset.representations) {
			if (!representation.publicationBucket || !representation.publicationObjectKey) continue;
			targets.push({
				bucket: representation.publicationBucket,
				storageKey: representation.publicationObjectKey,
				reason: `${config.reason}-publication-target-${representation.role.toLowerCase()}`,
			});
		}
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
		void projectId;
		return [{
			bucket: config.protectedBucket,
			storageKey: upload.objectKey,
			reason: `${config.reason}-active-upload`,
		}];
	});
}

export function projectWebglDeletionTargets(
	projectId: number,
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

	const unique = new Map(targets.map((target) => [
		`${target.bucket}\u0000${target.storageKey}`,
		target,
	]));
	return [...unique.values()];
}
