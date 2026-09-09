import { cleanupSourceChangeRequests } from '../../project-change/transaction.js';
import {
	Prisma,
	type PrismaClient,
} from '../../../generated/prisma/client.js';
import { conflict } from '../../../shared/errors.js';
import { queueDurableDeletions } from '../../orphan/outbox.js';
import { queueMultipartAbortTask } from '../../multipart-abort/repository.js';
import {
	projectActiveUploadDeletionTargets,
	projectAssetDeletionTargets,
	projectWebglDeletionTargets,
} from '../project/project-deletion-targets.js';
import type {
	ExhibitionDeletionOutboxConfig,
	PosterDeletionOutboxConfig,
} from './ports.js';

type TransactionClient = Prisma.TransactionClient;

export interface ExhibitionMutationTransactionPolicy {
	readonly isolationLevel: typeof Prisma.TransactionIsolationLevel.Serializable;
	readonly maxAttempts: number;
	readonly onRetry?: (attempt: number, error: unknown) => void;
}

export const EXHIBITION_MUTATION_TRANSACTION_POLICY: ExhibitionMutationTransactionPolicy = Object.freeze({
	isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
	maxAttempts: 3,
});

function isRetryableExhibitionMutationError(error: unknown): boolean {
	if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
	if (error.code === 'P2034') return true;
	if (error.code !== 'P2010') return false;

	const driverError = error.meta?.['driverAdapterError'];
	if (!driverError || typeof driverError !== 'object' || !('cause' in driverError)) return false;
	const cause = driverError.cause;
	return !!cause
		&& typeof cause === 'object'
		&& 'kind' in cause
		&& 'originalCode' in cause
		&& ((cause.kind === 'TransactionWriteConflict' && cause.originalCode === '40001')
			|| (cause.kind === 'postgres' && cause.originalCode === '40P01'));
}

export async function withExhibitionMutationTransaction<T>(
	client: Pick<PrismaClient, '$transaction'>,
	operation: (tx: TransactionClient) => Promise<T>,
	policy: ExhibitionMutationTransactionPolicy = EXHIBITION_MUTATION_TRANSACTION_POLICY,
): Promise<T> {
	if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
		throw new RangeError('Exhibition mutation maxAttempts must be a positive integer');
	}
	for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
		try {
			return await client.$transaction(operation, {
				isolationLevel: policy.isolationLevel,
			});
		} catch (error) {
			if (!isRetryableExhibitionMutationError(error)) throw error;
			if (attempt === policy.maxAttempts) {
				throw conflict('Exhibition changed concurrently; retry the request');
			}
			policy.onRetry?.(attempt, error);
		}
	}
	throw new Error('Exhibition mutation retry policy exhausted unexpectedly');
}

async function lockExhibition(
	tx: TransactionClient,
	id: number,
): Promise<{ id: number; posterAssetId: number | null } | null> {
	const rows = await tx.$queryRaw<Array<{
		id: number;
		posterAssetId: number | null;
	}>>`
		SELECT
			"id",
			"poster_asset_id" AS "posterAssetId"
		FROM "exhibitions"
		WHERE "id" = ${id}
		FOR UPDATE
	`;
	return rows[0] ?? null;
}

const exhibitionPosterInclude = {
	_count: { select: { projects: { where: { changeRequestDraft: null } } } },
	poster: { include: { representations: { where: { state: 'READY' as const } } } },
} as const;

/**
 * Context-owned repository. Poster pointer mutations lock the exhibition row
 * inside a bounded Serializable transaction. Object uploads/deletes never run
 * in these transactions; only pointer mutation and its durable outbox intent do.
 */
export function createExhibitionRepository(
	prisma: PrismaClient,
	policy: ExhibitionMutationTransactionPolicy = EXHIBITION_MUTATION_TRANSACTION_POLICY,
) {
	/** @returns All exhibitions ordered by sortOrder asc, year desc, with project counts */
	function findAllExhibitions() {
		return prisma.exhibition.findMany({
			orderBy: [{ sortOrder: 'asc' }, { year: 'desc' }],
			include: exhibitionPosterInclude,
		});
	}

	/** @returns Exhibition matching the unique (year, title) pair, or null */
	function findExhibitionByComposite(year: number, title: string) {
		return prisma.exhibition.findUnique({
			where: { year_title: { year, title } },
		});
	}

	/** @returns Exhibition by primary key, or null */
	function findExhibitionById(id: number) {
		return prisma.exhibition.findUnique({ where: { id } });
	}

	/** @returns Exhibition by primary key with project count, or null */
	function findExhibitionByIdWithCount(id: number) {
		return prisma.exhibition.findUnique({
			where: { id },
			include: exhibitionPosterInclude,
		});
	}

	/** Create a new Exhibition record */
	function createExhibition(data: {
		year: number;
		title?: string;
		isModificationEnabled?: boolean;
		sortOrder?: number;
	}) {
		return prisma.exhibition.create({ data });
	}

	/** Delete an Exhibition by primary key (cascades via DB FK) */
	function deleteExhibition(id: number, outbox: ExhibitionDeletionOutboxConfig) {
		return withExhibitionMutationTransaction(prisma, async (tx) => {
			const existing = await lockExhibition(tx, id);
			if (!existing) return null;
			const sources = await tx.project.findMany({ where: { exhibitionId: id, changeRequestDraft: null }, select: { id: true }, orderBy: { id: 'asc' } });
			for (const source of sources) await cleanupSourceChangeRequests(tx, source.id);
			const [projects, activeUploads, assets] = await Promise.all([
				tx.project.findMany({
					where: { exhibitionId: id },
					select: {
						id: true,
						webglDeployments: {
							select: {
								id: true, projectId: true, publicBucket: true, publicPrefix: true,
								entryObjectKey: true, objectManifest: true,
								sourceRepresentation: {
									select: { id: true, assetId: true, role: true, bucket: true, objectKey: true },
								},
							},
						},
					},
				}),
				tx.assetUploadSession.findMany({
					where: {
						project: { exhibitionId: id },
						state: { in: ['ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING'] },
					},
					select: {
						id: true,
						projectId: true,
						kind: true,
						objectKey: true,
						uploadId: true,
					},
				}),
				tx.asset.findMany({
					where: { OR: [{ project: { exhibitionId: id } }, { exhibitionId: id }] },
					include: { representations: true },
				}),
			]);
			const canonicalActiveUploads = activeUploads.map((upload) => ({
				projectId: upload.projectId ?? undefined,
				uploadKind: upload.kind,
				objectKey: upload.objectKey,
				uploadId: upload.uploadId,
				canonicalSessionId: upload.id,
			}));
			const targets = [
				...projectAssetDeletionTargets(assets, outbox),
				...projects.flatMap((project) => projectWebglDeletionTargets(
					project.id,
					outbox,
					project.webglDeployments,
				)),
				...projects.flatMap((project) => projectActiveUploadDeletionTargets(
					project.id,
					canonicalActiveUploads.filter((upload) => upload.projectId === project.id),
					outbox,
				)),
			];
			await queueDurableDeletions(tx, targets);
			for (const upload of canonicalActiveUploads) {
				if (!upload.objectKey || !upload.uploadId) continue;
				await queueMultipartAbortTask(tx, {
					bucket: outbox.protectedBucket,
					storageKey: upload.objectKey,
					uploadId: upload.uploadId,
					reason: `${outbox.reason}-active-multipart`,
					uploadSessionId: upload.canonicalSessionId,
				});
			}
			await tx.exhibition.delete({ where: { id } });
			return { id: existing.id, cleanupQueued: targets.length > 0 || canonicalActiveUploads.length > 0 };
		}, policy);
	}

	/** Partial-update an Exhibition and return the updated record with project count */
	function updateExhibition(
		id: number,
		data: { title?: string; isModificationEnabled?: boolean; sortOrder?: number },
	) {
		return prisma.exhibition.update({
			where: { id },
			data,
			include: exhibitionPosterInclude,
		});
	}

	/** Clear a canonical poster pointer and enqueue its representation cleanup. */
	async function clearExhibitionPoster(id: number, outbox: PosterDeletionOutboxConfig) {
		return withExhibitionMutationTransaction(prisma, async (tx) => {
			const existing = await lockExhibition(tx, id);
			if (!existing) return null;
			const previousPoster = existing.posterAssetId === null ? null : await tx.asset.findUnique({
				where: { id: existing.posterAssetId },
				include: { representations: true },
			});
			if (previousPoster) {
				await queueDurableDeletions(tx, projectAssetDeletionTargets([previousPoster], {
					publicBucket: outbox.bucket,
					protectedBucket: outbox.bucket,
					reason: outbox.reason,
				}));
				await tx.asset.update({ where: { id: previousPoster.id }, data: { status: 'DELETED' } });
			}
			const updated = await tx.exhibition.update({
				where: { id },
				data: { posterAssetId: null },
				include: exhibitionPosterInclude,
			});

			return {
				updated,
				cleanupQueued: previousPoster !== null,
			};
		}, policy);
	}

	return {
		findAllExhibitions,
		findExhibitionByComposite,
		findExhibitionById,
		findExhibitionByIdWithCount,
		createExhibition,
		deleteExhibition,
		updateExhibition,
		clearExhibitionPoster,
	};
}
