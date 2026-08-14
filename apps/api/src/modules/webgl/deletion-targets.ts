import type { DurableDeletionTarget } from '../orphan/outbox.js';
import {
	parseWebglEntryKey,
	parseWebglSourceKey,
	type WebglDeploymentKeys,
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

export function webglDeletionTargetsByEntry(
	projectId: number,
	entryKey: string,
	buckets: WebglDeletionBuckets,
	reason: string,
): DurableDeletionTarget[] {
	if (!entryKey) return [];
	const keys = parseWebglEntryKey(projectId, entryKey);
	if (!keys) throw new Error(`Malformed WebGL entry key for project ${projectId}`);
	return webglDeletionTargets(keys, buckets, reason);
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
	return webglDeletionTargets(keys, buckets, reason);
}
