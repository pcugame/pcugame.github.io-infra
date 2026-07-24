import type {
	AssetKind,
	AssetPlaybackStatus,
	Prisma,
	PrismaClient,
} from '../../../generated/prisma/client.js';
import { Prisma as PrismaRuntime } from '../../../generated/prisma/client.js';
import { notFound } from '../../../shared/errors.js';
import { assertValidPosterAsset } from '../../../shared/poster-validation.js';
import {
	ASSET_MUTATION_TRANSACTION_POLICY,
	type AssetMutationTransactionPolicy,
	withAssetMutationTransaction,
} from '../../assets/mutation-transaction.js';
import { queueDurableDeletions } from '../../orphan/outbox.js';
import type { AssetReplacementOutboxConfig } from './ports.js';

type TxClient = Prisma.TransactionClient;

type LockedReplaceableAsset = {
	id: number;
	storageKey: string;
	playbackStorageKey: string | null;
};

/**
 * Ticket-005 project asset mutation contract. Legacy compatibility and the
 * context-owned ticket-011 graph both call this single implementation.
 */
export function createProjectAssetMutationRepository(
	client: PrismaClient,
	transactionPolicy: AssetMutationTransactionPolicy = ASSET_MUTATION_TRANSACTION_POLICY,
) {
	async function lockProject(tx: TxClient, projectId: number): Promise<void> {
		const rows = await tx.$queryRaw<Array<{ id: number }>>(PrismaRuntime.sql`
			SELECT "id"
			FROM "projects"
			WHERE "id" = ${projectId}
			FOR UPDATE
		`);
		if (rows.length === 0) throw notFound('Project not found');
	}

	async function lockReadyAsset(
		tx: TxClient,
		projectId: number,
		kind: AssetKind,
	): Promise<LockedReplaceableAsset | null> {
		const rows = await tx.$queryRaw<LockedReplaceableAsset[]>(PrismaRuntime.sql`
			SELECT
				"id",
				"storage_key" AS "storageKey",
				"playback_storage_key" AS "playbackStorageKey"
			FROM "assets"
			WHERE "project_id" = ${projectId}
				AND "kind" = CAST(${kind} AS "AssetKind")
				AND "status" = 'READY'
			ORDER BY "id"
			LIMIT 1
			FOR UPDATE
		`);
		return rows[0] ?? null;
	}

	return {
		replaceOrCreateReplaceableAsset(
			projectId: number,
			kind: AssetKind,
			data: {
				storageKey: string;
				playbackStorageKey?: string | null;
				originalName: string;
				mimeType: string;
				playbackMimeType?: string;
				sizeBytes: bigint;
				playbackSizeBytes?: bigint;
				playbackStatus?: AssetPlaybackStatus;
				playbackError?: string;
				isPublic: boolean;
			},
			outbox: AssetReplacementOutboxConfig,
		): Promise<{
			assetId: number;
			oldStorageKey: string | null;
			oldPlaybackStorageKey: string | null;
		}> {
			return withAssetMutationTransaction(client, async (tx) => {
				await lockProject(tx, projectId);
				const existing = await lockReadyAsset(tx, projectId, kind);

				if (existing) {
					await queueDurableDeletions(tx, [
						...(existing.storageKey !== data.storageKey
							? [{
									bucket: outbox.bucket,
									storageKey: existing.storageKey,
									reason: outbox.reason,
								}]
							: []),
						...(existing.playbackStorageKey
							&& existing.playbackStorageKey !== data.playbackStorageKey
							&& existing.playbackStorageKey !== data.storageKey
							? [{
									bucket: outbox.bucket,
									storageKey: existing.playbackStorageKey,
									reason: outbox.playbackReason,
								}]
							: []),
					]);
					await tx.project.updateMany({
						where: { id: projectId, posterAssetId: existing.id },
						data: { posterAssetId: null },
					});
					await tx.asset.update({
						where: { id: existing.id },
						data: { status: 'DELETED' },
						select: { id: true },
					});
				}

				const created = await tx.asset.create({
					data: {
						projectId,
						kind,
						storageKey: data.storageKey,
						playbackStorageKey: data.playbackStorageKey ?? null,
						originalName: data.originalName,
						mimeType: data.mimeType,
						playbackMimeType: data.playbackMimeType ?? '',
						sizeBytes: data.sizeBytes,
						playbackSizeBytes: data.playbackSizeBytes ?? BigInt(0),
						playbackStatus: data.playbackStatus ?? 'PENDING',
						playbackError: data.playbackError ?? '',
						isPublic: data.isPublic,
					},
					select: { id: true },
				});
				return {
					assetId: created.id,
					oldStorageKey: existing?.storageKey ?? null,
					oldPlaybackStorageKey: existing?.playbackStorageKey ?? null,
				};
			}, transactionPolicy);
		},

		setProjectPoster(projectId: number, assetId: number): Promise<unknown> {
			return withAssetMutationTransaction(client, async (tx) => {
				await lockProject(tx, projectId);
				const rows = await tx.$queryRaw<Array<{
					id: number;
					projectId: number;
					kind: AssetKind;
					status: string;
				}>>(PrismaRuntime.sql`
					SELECT
						"id",
						"project_id" AS "projectId",
						"kind"::text AS "kind",
						"status"::text AS "status"
					FROM "assets"
					WHERE "id" = ${assetId}
					FOR UPDATE
				`);
				assertValidPosterAsset(rows[0] ?? null, projectId);
				return tx.project.update({
					where: { id: projectId },
					data: { posterAssetId: assetId },
				});
			}, transactionPolicy);
		},
	};
}
