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

export interface AssetDeletionClaim {
	id: number;
	projectId: number;
	kind: AssetKind;
	previousStatus: AssetStatus;
	storageKey: string;
	playbackStorageKey: string | null;
	alreadyDeleted: boolean;
}

type LockedAssetDeletionRow = {
	id: number;
	projectId: number;
	kind: AssetKind;
	status: AssetStatus;
	storageKey: string;
	playbackStorageKey: string | null;
};

export function createAssetsRepository(
	client: PrismaClient,
	transactionPolicy: AssetMutationTransactionPolicy = ASSET_MUTATION_TRANSACTION_POLICY,
) {
	return {
		/** Find a public, READY asset by storageKey */
		findPublicAsset(storageKey: string) {
			return client.asset.findFirst({
				where: { storageKey, isPublic: true, status: 'READY' },
			});
		},

		/** Find any READY asset by storageKey (including protected) */
		findAssetByStorageKey(storageKey: string) {
			return client.asset.findFirst({
				where: {
					status: 'READY',
					OR: [
						{ storageKey },
						{ playbackStorageKey: storageKey },
					],
				},
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
				},
			});
		},

		/** Find an asset by ID with its project relation */
		findAssetByIdWithProject(id: number) {
			return client.asset.findUnique({
				where: { id },
				include: { project: true },
			});
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
				if (!candidate) return null;

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
						"status"::text AS "status",
						"storage_key" AS "storageKey",
						"playback_storage_key" AS "playbackStorageKey"
					FROM "assets"
					WHERE "id" = ${id}
					FOR UPDATE
				`);
				const asset = rows[0];
				if (!asset) return null;

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
					storageKey: asset.storageKey,
					playbackStorageKey: asset.playbackStorageKey,
					alreadyDeleted: asset.status === 'DELETED',
				};
			}, transactionPolicy);
		},

		/** Finish only the exact identity claimed above; never terminalize a reused row. */
		async completeAssetDeletion(claim: AssetDeletionClaim): Promise<void> {
			const result = await client.asset.updateMany({
				where: {
					id: claim.id,
					projectId: claim.projectId,
					kind: claim.kind,
					status: 'DELETING',
					storageKey: claim.storageKey,
					playbackStorageKey: claim.playbackStorageKey,
				},
				data: { status: 'DELETED' },
			});
			if (result.count === 1) return;

			const current = await client.asset.findUnique({
				where: { id: claim.id },
				select: {
					projectId: true,
					kind: true,
					status: true,
					storageKey: true,
					playbackStorageKey: true,
				},
			});
			if (current
				&& current.projectId === claim.projectId
				&& current.kind === claim.kind
				&& current.status === 'DELETED'
				&& current.storageKey === claim.storageKey
				&& current.playbackStorageKey === claim.playbackStorageKey) {
				return;
			}
			throw conflict('Asset identity changed before deletion completed');
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
