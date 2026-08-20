import type { DurableDeletionTarget } from '../orphan/outbox.js';
import {
	parseWebglEntryKey,
	parseWebglSourceKey,
	type WebglDeploymentKeys,
	type WebglProtectedSourceKeys,
	type WebglPublicDeploymentKeys,
} from './paths.js';

export interface WebglDeletionBuckets {
	publicBucket: string;
	protectedBucket: string;
}

export function webglDeletionTargets(
	keys: WebglDeploymentKeys,
	buckets: WebglDeletionBuckets,
	reason: string,
): DurableDeletionTarget[] {
	return [
		{
			bucket: buckets.protectedBucket,
			storageKey: keys.sourceKey,
			reason: `${reason}-source`,
		},
		{
			bucket: buckets.publicBucket,
			storageKey: keys.sitePrefix,
			targetKind: 'PREFIX',
			reason: `${reason}-site`,
		},
	];
}

export function webglPublicDeletionTarget(
	keys: WebglPublicDeploymentKeys,
	bucket: string,
	reason: string,
): DurableDeletionTarget {
	return {
		bucket,
		storageKey: keys.sitePrefix,
		targetKind: 'PREFIX',
		reason: `${reason}-site`,
	};
}

export function webglSourceDeletionTarget(
	keys: WebglProtectedSourceKeys,
	bucket: string,
	reason: string,
): DurableDeletionTarget {
	return { bucket, storageKey: keys.sourceKey, reason: `${reason}-source` };
}

export function webglDeletionTargetsByEntry(
	projectId: number,
	entryKey: string,
	buckets: WebglDeletionBuckets,
	reason: string,
): DurableDeletionTarget[] {
	if (!entryKey) return [];
	const keys = parseWebglEntryKey(projectId, entryKey);
	if (!keys) throw new Error(`Malformed WebGL entry key for project ${projectId}`);
	return [webglPublicDeletionTarget(keys, buckets.publicBucket, reason)];
}

export function webglDeletionTargetsBySource(
	projectId: number,
	sourceKey: string,
	buckets: WebglDeletionBuckets,
	reason: string,
): DurableDeletionTarget[] {
	if (!sourceKey) return [];
	const keys = parseWebglSourceKey(projectId, sourceKey);
	if (!keys) {
		return [{ bucket: buckets.protectedBucket, storageKey: sourceKey, reason }];
	}
	return [webglSourceDeletionTarget(keys, buckets.protectedBucket, reason)];
}
