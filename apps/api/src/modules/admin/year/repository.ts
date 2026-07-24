import {
	Prisma,
	type PrismaClient,
} from '../../../generated/prisma/client.js';
import { conflict } from '../../../shared/errors.js';
import { queueDurableDeletions } from '../../orphan/outbox.js';

interface PosterDeletionOutboxConfig {
	bucket: string;
	reason: string;
}

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
			include: { _count: { select: { projects: true } } },
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
			include: { _count: { select: { projects: true } } },
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
	function deleteExhibition(id: number, outbox: PosterDeletionOutboxConfig) {
		return withExhibitionMutationTransaction(prisma, async (tx) => {
			const existing = await lockExhibition(tx, id);
			if (!existing) return null;
			if (existing.posterStorageKey) {
				await queueDurableDeletions(tx, [{
					bucket: outbox.bucket,
					storageKey: existing.posterStorageKey,
					reason: outbox.reason,
				}]);
			}
			await tx.exhibition.delete({ where: { id } });
			return existing;
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
			include: { _count: { select: { projects: true } } },
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
		},
		outbox: PosterDeletionOutboxConfig,
	) {
		return withExhibitionMutationTransaction(prisma, async (tx) => {
			const existing = await lockExhibition(tx, id);
			if (!existing) return null;
			if (existing.posterStorageKey && existing.posterStorageKey !== data.storageKey) {
				await queueDurableDeletions(tx, [{
					bucket: outbox.bucket,
					storageKey: existing.posterStorageKey,
					reason: outbox.reason,
				}]);
			}

			const updated = await tx.exhibition.update({
				where: { id },
				data: {
					posterStorageKey: data.storageKey,
					posterOriginalName: data.originalName,
					posterMimeType: data.mimeType,
					posterSizeBytes: data.sizeBytes,
				},
				include: { _count: { select: { projects: true } } },
			});

			return { updated, oldStorageKey: existing.posterStorageKey };
		}, policy);
	}

	/** Clear poster metadata from an exhibition and return the removed key. */
	async function clearExhibitionPoster(id: number, outbox: PosterDeletionOutboxConfig) {
		return withExhibitionMutationTransaction(prisma, async (tx) => {
			const existing = await lockExhibition(tx, id);
			if (!existing) return null;
			if (existing.posterStorageKey) {
				await queueDurableDeletions(tx, [{
					bucket: outbox.bucket,
					storageKey: existing.posterStorageKey,
					reason: outbox.reason,
				}]);
			}

			const updated = await tx.exhibition.update({
				where: { id },
				data: {
					posterStorageKey: null,
					posterOriginalName: '',
					posterMimeType: '',
					posterSizeBytes: 0,
				},
				include: { _count: { select: { projects: true } } },
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
