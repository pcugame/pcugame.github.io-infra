import {
	Prisma,
	type PrismaClient,
} from '../../../generated/prisma/client.js';
import type { SavedImageRendition } from '../../../application/upload-ports.js';
import { conflict } from '../../../shared/errors.js';
import { queueDurableDeletions } from '../../orphan/outbox.js';
import { commitUploadIntents } from '../../upload-intent/repository.js';
import { queueMultipartAbortTask } from '../../multipart-abort/repository.js';
import {
	imageRenditionCreateManyData,
	imageRenditionDeletionTargets,
} from '../../assets/image-rendition-lifecycle.js';
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
		&& cause.kind === 'TransactionWriteConflict'
		&& 'originalCode' in cause
		&& cause.originalCode === '40001';
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
): Promise<{ id: number; posterStorageKey: string | null } | null> {
	const rows = await tx.$queryRaw<Array<{ id: number; posterStorageKey: string | null }>>`
		SELECT
			"id",
			"poster_storage_key" AS "posterStorageKey"
		FROM "exhibitions"
		WHERE "id" = ${id}
		FOR UPDATE
	`;
	return rows[0] ?? null;
}

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
			include: {
				_count: { select: { projects: true } },
				imageRenditions: true,
			},
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
			include: {
				_count: { select: { projects: true } },
				imageRenditions: true,
			},
		});
	}

	/** Create a new Exhibition record */
	function createExhibition(data: {
		year: number;
		title?: string;
		isUploadEnabled?: boolean;
		sortOrder?: number;
	}) {
		return prisma.exhibition.create({ data });
	}

	/** Delete an Exhibition by primary key (cascades via DB FK) */
	function deleteExhibition(id: number, outbox: ExhibitionDeletionOutboxConfig) {
		return withExhibitionMutationTransaction(prisma, async (tx) => {
			const existing = await lockExhibition(tx, id);
			if (!existing) return null;
			const [posterRenditions, projects, activeUploads, assets] = await Promise.all([
				tx.imageRendition.findMany({
					where: {
						exhibitionId: id,
						sourceStorageKey: existing.posterStorageKey ?? undefined,
					},
					select: { storageKey: true, sourceStorageKey: true },
				}),
				tx.project.findMany({
					where: { exhibitionId: id },
					select: { id: true, webglEntryKey: true },
				}),
				tx.gameUploadSession.findMany({
					where: {
						project: { exhibitionId: id },
						status: { in: ['PENDING', 'COMPLETING'] },
					},
					select: {
						id: true,
						projectId: true,
						uploadKind: true,
						s3Key: true,
						s3UploadId: true,
					},
				}),
				tx.asset.findMany({
					where: { project: { exhibitionId: id } },
					include: { imageRenditions: true },
				}),
			]);
			const targets = [
				...(existing.posterStorageKey ? [{
					bucket: outbox.publicBucket,
					storageKey: existing.posterStorageKey,
					reason: `${outbox.reason}-poster`,
				}] : []),
				...imageRenditionDeletionTargets(
					outbox.publicBucket,
					existing.posterStorageKey,
					posterRenditions,
					`${outbox.reason}-poster-rendition`,
				),
				...projectAssetDeletionTargets(assets, outbox),
				...projects.flatMap((project) => projectWebglDeletionTargets(
					project.id,
					project.webglEntryKey,
					outbox,
				)),
				...projects.flatMap((project) => projectActiveUploadDeletionTargets(
					project.id,
					activeUploads.filter((upload) => upload.projectId === project.id),
					outbox,
				)),
			];
			await queueDurableDeletions(tx, targets);
			for (const upload of activeUploads) {
				if (!upload.s3Key || !upload.s3UploadId) continue;
				await queueMultipartAbortTask(tx, {
					bucket: outbox.protectedBucket,
					storageKey: upload.s3Key,
					uploadId: upload.s3UploadId,
					reason: `${outbox.reason}-active-multipart`,
				});
			}
			await tx.exhibition.delete({ where: { id } });
			return { ...existing, cleanupQueued: targets.length > 0 || activeUploads.length > 0 };
		}, policy);
	}

	/** Partial-update an Exhibition and return the updated record with project count */
	function updateExhibition(
		id: number,
		data: { title?: string; isUploadEnabled?: boolean; sortOrder?: number },
	) {
		return prisma.exhibition.update({
			where: { id },
			data,
			include: {
				_count: { select: { projects: true } },
				imageRenditions: true,
			},
		});
	}

	/** Store processed poster metadata on an exhibition and return the previous key. */
	async function replaceExhibitionPoster(
		id: number,
		data: {
			storageKey: string;
			originalName: string;
			mimeType: string;
			sizeBytes: bigint;
			width?: number;
			height?: number;
			renditions?: SavedImageRendition[];
			uploadIntentIds?: string[];
		},
		outbox: PosterDeletionOutboxConfig,
	) {
		return withExhibitionMutationTransaction(prisma, async (tx) => {
			const existing = await lockExhibition(tx, id);
			if (!existing) return null;
			const oldRenditions = await tx.imageRendition.findMany({
				where: {
					exhibitionId: id,
					sourceStorageKey: existing.posterStorageKey ?? undefined,
				},
				select: { storageKey: true, sourceStorageKey: true },
			});
			if (existing.posterStorageKey && existing.posterStorageKey !== data.storageKey) {
				await queueDurableDeletions(tx, [
					{
						bucket: outbox.bucket,
						storageKey: existing.posterStorageKey,
						reason: outbox.reason,
					},
					...imageRenditionDeletionTargets(
						outbox.bucket,
						existing.posterStorageKey,
						oldRenditions,
						`${outbox.reason}-rendition`,
					),
				]);
				await tx.imageRendition.deleteMany({
					where: {
						exhibitionId: id,
						sourceStorageKey: existing.posterStorageKey,
					},
				});
			}

			await tx.exhibition.update({
				where: { id },
				data: {
					posterStorageKey: data.storageKey,
					posterOriginalName: data.originalName,
					posterMimeType: data.mimeType,
					posterSizeBytes: data.sizeBytes,
					posterWidth: data.width,
					posterHeight: data.height,
				},
				include: {
					_count: { select: { projects: true } },
					imageRenditions: true,
				},
			});
			const renditionData = imageRenditionCreateManyData(
				{ exhibitionId: id },
				data.storageKey,
				data.renditions ?? [],
			);
			if (renditionData.length > 0) {
				await tx.imageRendition.createMany({ data: renditionData });
			}
			await commitUploadIntents(tx, data.uploadIntentIds ?? []);

			return {
				updated: await tx.exhibition.findUniqueOrThrow({
					where: { id },
					include: {
						_count: { select: { projects: true } },
						imageRenditions: true,
					},
				}),
				oldStorageKey: existing.posterStorageKey,
			};
		}, policy);
	}

	/** Clear poster metadata from an exhibition and return the removed key. */
	async function clearExhibitionPoster(id: number, outbox: PosterDeletionOutboxConfig) {
		return withExhibitionMutationTransaction(prisma, async (tx) => {
			const existing = await lockExhibition(tx, id);
			if (!existing) return null;
			const oldRenditions = await tx.imageRendition.findMany({
				where: {
					exhibitionId: id,
					sourceStorageKey: existing.posterStorageKey ?? undefined,
				},
				select: { storageKey: true, sourceStorageKey: true },
			});
			if (existing.posterStorageKey) {
				await queueDurableDeletions(tx, [
					{
						bucket: outbox.bucket,
						storageKey: existing.posterStorageKey,
						reason: outbox.reason,
					},
					...imageRenditionDeletionTargets(
						outbox.bucket,
						existing.posterStorageKey,
						oldRenditions,
						`${outbox.reason}-rendition`,
					),
				]);
				await tx.imageRendition.deleteMany({
					where: {
						exhibitionId: id,
						sourceStorageKey: existing.posterStorageKey,
					},
				});
			}

			const updated = await tx.exhibition.update({
				where: { id },
				data: {
					posterStorageKey: null,
					posterOriginalName: '',
					posterMimeType: '',
					posterSizeBytes: 0,
					posterWidth: null,
					posterHeight: null,
				},
				include: {
					_count: { select: { projects: true } },
					imageRenditions: true,
				},
			});

			return { updated, oldStorageKey: existing.posterStorageKey };
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
		replaceExhibitionPoster,
		clearExhibitionPoster,
	};
}
