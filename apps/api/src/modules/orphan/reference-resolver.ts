import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { parseWebglEntryKey } from '../webgl/paths.js';

export type ObjectTargetKind = 'EXACT' | 'PREFIX';

export interface ObjectReference {
	bucket: string;
	targetKind: ObjectTargetKind;
	key: string;
	source: string;
}

export interface ObjectReferenceInventory {
	references: ObjectReference[];
	/** A malformed durable pointer makes deletion in that bucket fail closed. */
	unsafeBuckets: Set<string>;
}

export interface ObjectReferenceBuckets {
	publicBucket: string;
	protectedBucket: string;
}

export interface ObjectReferenceLogger {
	error(context: Record<string, unknown>, message: string): void;
}

/**
 * Reference writers and deletion claimers take the same transaction-scoped
 * PostgreSQL advisory lock. Keeping one global lock makes EXACT/PREFIX overlap
 * ordering unambiguous; it is held only for the short database transaction and
 * never while object storage is called.
 */
export const OBJECT_REFERENCE_CLAIM_LOCK_ID = BigInt('5783552944012313923');

export function targetsOverlap(
	left: Pick<ObjectReference, 'bucket' | 'targetKind' | 'key'>,
	right: Pick<ObjectReference, 'bucket' | 'targetKind' | 'key'>,
): boolean {
	if (left.bucket !== right.bucket) return false;
	if (left.targetKind === 'EXACT' && right.targetKind === 'EXACT') {
		return left.key === right.key;
	}
	if (left.targetKind === 'PREFIX' && right.targetKind === 'PREFIX') {
		return left.key.startsWith(right.key) || right.key.startsWith(left.key);
	}
	const prefix = left.targetKind === 'PREFIX' ? left.key : right.key;
	const exact = left.targetKind === 'EXACT' ? left.key : right.key;
	return exact.startsWith(prefix);
}

export function inventoryReferencesTarget(
	inventory: ObjectReferenceInventory,
	target: Pick<ObjectReference, 'bucket' | 'targetKind' | 'key'>,
): boolean {
	if (inventory.unsafeBuckets.has(target.bucket)) return true;
	return inventory.references.some((reference) => targetsOverlap(reference, target));
}

/**
 * Authoritative inventory for every live object pointer. Asset rows remain live
 * until their state reaches DELETED; upload intents bridge the PUT-to-commit gap.
 */
export async function collectObjectReferences(
	client: Pick<
		PrismaClient,
		'asset' | 'exhibition' | 'project' | 'gameUploadSession' | 'uploadIntent'
	>,
	buckets: ObjectReferenceBuckets,
	logger: ObjectReferenceLogger,
): Promise<ObjectReferenceInventory> {
	const [assets, exhibitions, projects, completedSessions, activeSessions, intents] = await Promise.all([
		client.asset.findMany({
			where: { status: { not: 'DELETED' } },
			select: {
				id: true,
				storageKey: true,
				playbackStorageKey: true,
				isPublic: true,
			},
		}),
		client.exhibition.findMany({
			where: { posterStorageKey: { not: null } },
			select: { id: true, posterStorageKey: true },
		}),
		client.project.findMany({
			where: { webglEntryKey: { not: '' } },
			select: { id: true, webglEntryKey: true },
		}),
		client.gameUploadSession.findMany({
			where: { status: 'COMPLETED', storageKey: { not: null } },
			select: { id: true, storageKey: true },
		}),
		client.gameUploadSession.findMany({
			where: { status: { in: ['PENDING', 'COMPLETING'] }, s3Key: { not: null } },
			select: { id: true, s3Key: true },
		}),
		client.uploadIntent.findMany({
			where: { state: { in: ['PREPARED', 'UPLOADED'] } },
			select: { id: true, bucket: true, storageKey: true },
		}),
	]);

	const references: ObjectReference[] = [];
	for (const asset of assets) {
		const bucket = asset.isPublic ? buckets.publicBucket : buckets.protectedBucket;
		references.push({
			bucket,
			targetKind: 'EXACT',
			key: asset.storageKey,
			source: `asset:${asset.id}:original`,
		});
		if (asset.playbackStorageKey) {
			references.push({
				bucket,
				targetKind: 'EXACT',
				key: asset.playbackStorageKey,
				source: `asset:${asset.id}:playback`,
			});
		}
	}
	for (const exhibition of exhibitions) {
		if (!exhibition.posterStorageKey) continue;
		references.push({
			bucket: buckets.publicBucket,
			targetKind: 'EXACT',
			key: exhibition.posterStorageKey,
			source: `exhibition:${exhibition.id}:poster`,
		});
	}

	const unsafeBuckets = new Set<string>();
	for (const project of projects) {
		const parsed = parseWebglEntryKey(project.id, project.webglEntryKey);
		if (!parsed) {
			unsafeBuckets.add(buckets.publicBucket);
			unsafeBuckets.add(buckets.protectedBucket);
			logger.error(
				{ projectId: project.id, webglEntryKey: project.webglEntryKey },
				'Malformed WebGL pointer encountered; WebGL bucket deletion is disabled',
			);
			continue;
		}
		references.push({
			bucket: buckets.protectedBucket,
			targetKind: 'EXACT',
			key: parsed.sourceKey,
			source: `project:${project.id}:webgl-source`,
		});
		references.push({
			bucket: buckets.publicBucket,
			targetKind: 'PREFIX',
			key: parsed.sitePrefix,
			source: `project:${project.id}:webgl-site`,
		});
	}
	for (const session of completedSessions) {
		if (!session.storageKey) continue;
		references.push({
			bucket: buckets.protectedBucket,
			targetKind: 'EXACT',
			key: session.storageKey,
			source: `upload-session:${session.id}:completed`,
		});
	}
	for (const session of activeSessions) {
		if (!session.s3Key) continue;
		references.push({
			bucket: buckets.protectedBucket,
			targetKind: 'EXACT',
			key: session.s3Key,
			source: `upload-session:${session.id}:active`,
		});
	}
	for (const intent of intents) {
		references.push({
			bucket: intent.bucket,
			targetKind: 'EXACT',
			key: intent.storageKey,
			source: `upload-intent:${intent.id}`,
		});
	}

	return { references, unsafeBuckets };
}

export function createObjectReferenceResolver(
	client: Parameters<typeof collectObjectReferences>[0],
	buckets: ObjectReferenceBuckets,
	logger: ObjectReferenceLogger,
) {
	return {
		collect: () => collectObjectReferences(client, buckets, logger),
		async isReferenced(target: { bucket: string; targetKind: ObjectTargetKind; key: string }) {
			return inventoryReferencesTarget(
				await collectObjectReferences(client, buckets, logger),
				target,
			);
		},
	};
}

/**
 * Reference writers call this inside their transaction. A claimed overlapping
 * deletion forces the writer to retry instead of committing a pointer to a key
 * that may already be in flight to object storage.
 */
export async function assertNoDeletionClaim(
	tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
	target: { bucket: string; key: string; targetKind?: ObjectTargetKind },
): Promise<void> {
	const targetKind = target.targetKind ?? 'EXACT';
	const overlapping = targetKind === 'EXACT'
		? await tx.$queryRaw<Array<{ id: number; activelyClaimed: boolean }>>`
			WITH object_reference_lock AS MATERIALIZED (
				SELECT pg_advisory_xact_lock(${OBJECT_REFERENCE_CLAIM_LOCK_ID})
			)
			SELECT
				orphan."id",
				(
					orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
					AND orphan."claim_until" > CURRENT_TIMESTAMP
				) AS "activelyClaimed"
			FROM "orphan_objects" AS orphan
			CROSS JOIN object_reference_lock
			WHERE orphan."bucket" = ${target.bucket}
				AND (
					(orphan."target_kind" = 'EXACT'::"OrphanTargetKind" AND orphan."storage_key" = ${target.key})
					OR (
						orphan."target_kind" = 'PREFIX'::"OrphanTargetKind"
						AND LEFT(${target.key}, LENGTH(orphan."storage_key")) = orphan."storage_key"
					)
				)
			FOR UPDATE OF orphan
		`
		: await tx.$queryRaw<Array<{ id: number; activelyClaimed: boolean }>>`
			WITH object_reference_lock AS MATERIALIZED (
				SELECT pg_advisory_xact_lock(${OBJECT_REFERENCE_CLAIM_LOCK_ID})
			)
			SELECT
				orphan."id",
				(
					orphan."state" = 'DELETE_CLAIMED'::"OrphanState"
					AND orphan."claim_until" > CURRENT_TIMESTAMP
				) AS "activelyClaimed"
			FROM "orphan_objects" AS orphan
			CROSS JOIN object_reference_lock
			WHERE orphan."bucket" = ${target.bucket}
				AND (
					(
						orphan."target_kind" = 'EXACT'::"OrphanTargetKind"
						AND LEFT(orphan."storage_key", LENGTH(${target.key})) = ${target.key}
					)
					OR (
						orphan."target_kind" = 'PREFIX'::"OrphanTargetKind"
						AND (
							LEFT(orphan."storage_key", LENGTH(${target.key})) = ${target.key}
							OR LEFT(${target.key}, LENGTH(orphan."storage_key")) = orphan."storage_key"
						)
					)
				)
			FOR UPDATE OF orphan
		`;
	if (overlapping.some((row) => row.activelyClaimed)) {
		throw new Error(`Object deletion claim overlaps new reference: ${target.bucket}/${target.key}`);
	}
}
