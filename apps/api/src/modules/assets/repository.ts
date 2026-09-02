import {
	Prisma,
	type AssetKind,
	type AssetStatus,
	type PrismaClient,
} from '../../generated/prisma/client.js';
import { conflict } from '../../shared/errors.js';
import {
	ASSET_MUTATION_TRANSACTION_POLICY,
	type AssetMutationTransactionPolicy,
	withAssetMutationTransaction,
} from './mutation-transaction.js';
import { queueDurableDeletions } from '../orphan/outbox.js';

export interface AssetDeletionClaim {
	id: number;
	projectId: number;
	kind: AssetKind;
	previousStatus: AssetStatus;
	/** Present on repository claims; optional keeps the Phase-1 service port structurally compatible. */
	representations?: AssetRepresentationDeletionFence[];
	alreadyDeleted: boolean;
}

export interface AssetRepresentationDeletionFence {
	id: string;
	role: string;
	bucket: string;
	objectKey: string;
	updatedAt: Date;
	checksum: string | null;
}

type LockedAssetDeletionRow = {
	id: number;
	projectId: number | null;
	kind: AssetKind;
	status: AssetStatus;
};

type LockedRepresentationDeletionRow = AssetRepresentationDeletionFence;

function sameRepresentationFence(
	claimed: readonly AssetRepresentationDeletionFence[],
	current: readonly LockedRepresentationDeletionRow[],
): boolean {
	if (claimed.length !== current.length) return false;
	return claimed.every((expected, index) => {
		const actual = current[index];
		return actual !== undefined
			&& actual.id === expected.id
			&& actual.role === expected.role
			&& actual.bucket === expected.bucket
			&& actual.objectKey === expected.objectKey
			&& actual.checksum === expected.checksum
			&& actual.updatedAt.getTime() === expected.updatedAt.getTime();
	});
}

export function createAssetsRepository(
	client: PrismaClient,
	transactionPolicy: AssetMutationTransactionPolicy = ASSET_MUTATION_TRANSACTION_POLICY,
) {
	return {
		/** Canonical domain identity lookup; status is deliberately not hidden. */
		findAssetByIdForDownload(id: number) {
			return client.asset.findUnique({
				where: { id },
				include: {
					project: {
						select: {
							creatorId: true,
							title: true,
							status: true,
							members: {
								select: { id: true, userId: true, name: true, studentId: true, sortOrder: true },
								orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
							},
						},
					},
					representations: {
						where: { role: { in: ['ORIGINAL', 'PLAYBACK'] } },
						select: { role: true, bucket: true, objectKey: true, state: true },
					},
				},
			});
		},

		/** Find an asset by ID with its project relation */
		async findAssetByIdWithProject(id: number) {
			const asset = await client.asset.findUnique({
				where: { id },
				include: { project: true },
			});
			if (!asset || asset.projectId === null || !asset.project) return null;
			return {
				id: asset.id,
				projectId: asset.projectId,
				project: { posterAssetId: asset.project.posterAssetId },
			};
		},

		/**
		 * Lock the project and asset rows, snapshot the immutable object identity,
		 * transition to DELETING, and clear a matching poster pointer atomically.
		 * Object-storage I/O deliberately happens after this short transaction.
		 */
		claimAssetForDeletion(id: number): Promise<AssetDeletionClaim | null> {
			return withAssetMutationTransaction(client, async (tx) => {
				const candidate = await tx.asset.findUnique({
					where: { id },
					select: { projectId: true },
				});
					if (!candidate || candidate.projectId === null) return null;

				// Every asset/poster writer uses project -> asset lock order.
				const projects = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
					SELECT "id"
					FROM "projects"
					WHERE "id" = ${candidate.projectId}
					FOR UPDATE
				`);
				if (projects.length === 0) return null;

				const rows = await tx.$queryRaw<LockedAssetDeletionRow[]>(Prisma.sql`
					SELECT
						"id",
						"project_id" AS "projectId",
						"kind"::text AS "kind",
						"status"::text AS "status"
					FROM "assets"
					WHERE "id" = ${id}
					FOR UPDATE
				`);
				const asset = rows[0];
					if (!asset || asset.projectId === null) return null;
				const representations = await tx.$queryRaw<LockedRepresentationDeletionRow[]>(Prisma.sql`
					SELECT
						"id",
						"role"::text AS "role",
						"bucket",
						"object_key" AS "objectKey",
						"updated_at" AS "updatedAt",
						"checksum"
					FROM "asset_representations"
					WHERE "asset_id" = ${asset.id}
					ORDER BY "id"
					FOR UPDATE
				`);

				if (asset.status !== 'DELETED' && asset.status !== 'DELETING') {
					await tx.asset.update({
						where: { id: asset.id },
						data: { status: 'DELETING' },
						select: { id: true },
					});
				}
				await tx.project.updateMany({
					where: { id: asset.projectId, posterAssetId: asset.id },
					data: { posterAssetId: null },
				});

				return {
					id: asset.id,
					projectId: asset.projectId,
					kind: asset.kind,
					previousStatus: asset.status,
					representations,
					alreadyDeleted: asset.status === 'DELETED',
				};
			}, transactionPolicy);
		},

		/**
		 * Terminalize the exact claimed identity and create its deletion outbox in
		 * one transaction. Object-storage I/O is only a post-commit optimization.
		 */
		async completeAssetDeletion(
			claim: AssetDeletionClaim,
			outbox: { reason: string },
		): Promise<void> {
			await withAssetMutationTransaction(client, async (tx) => {
				const claimedRepresentations = claim.representations ?? [];
				const projects = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
					SELECT "id"
					FROM "projects"
					WHERE "id" = ${claim.projectId}
					FOR UPDATE
				`);
				if (projects.length === 0) return;

				const rows = await tx.$queryRaw<LockedAssetDeletionRow[]>(Prisma.sql`
					SELECT
						"id",
						"project_id" AS "projectId",
						"kind"::text AS "kind",
						"status"::text AS "status"
					FROM "assets"
					WHERE "id" = ${claim.id}
					FOR UPDATE
				`);
				const current = rows[0];
				if (!current) return;
				const currentRepresentations = await tx.$queryRaw<LockedRepresentationDeletionRow[]>(Prisma.sql`
					SELECT
						"id",
						"role"::text AS "role",
						"bucket",
						"object_key" AS "objectKey",
						"updated_at" AS "updatedAt",
						"checksum"
					FROM "asset_representations"
					WHERE "asset_id" = ${claim.id}
					ORDER BY "id"
					FOR UPDATE
				`);
				const sameIdentity = current.projectId === claim.projectId
					&& current.kind === claim.kind
					&& sameRepresentationFence(claimedRepresentations, currentRepresentations);
				if (!sameIdentity || (current.status !== 'DELETING' && current.status !== 'DELETED')) {
					throw conflict('Asset identity changed before deletion completed');
				}
					await queueDurableDeletions(tx, [
						...claimedRepresentations.map((representation) => ({
							bucket: representation.bucket,
							storageKey: representation.objectKey,
							reason: `${outbox.reason}-representation-${representation.role.toLowerCase()}`,
						})),
				]);
				if (current.status === 'DELETING') {
					const result = await tx.asset.updateMany({
						where: {
							id: claim.id,
							projectId: claim.projectId,
							kind: claim.kind,
							status: 'DELETING',
						},
						data: { status: 'DELETED' },
					});
					if (result.count !== 1) {
						throw conflict('Asset identity changed before deletion completed');
					}
				}
			}, transactionPolicy);
		},

		/** Upsert a banned IP record */
		upsertBannedIp(ip: string, reason: string) {
			return client.bannedIp.upsert({
				where: { ip },
				create: { ip, reason },
				update: {},
			});
		},

		/** Load all banned IPs (for in-memory cache init) */
		findAllBannedIps() {
			return client.bannedIp.findMany({ select: { ip: true } });
		},
	};
}
