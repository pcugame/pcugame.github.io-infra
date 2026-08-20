import {
	Prisma,
	type PrismaClient,
} from '../../../generated/prisma/client.js';
import type { SavedImageRendition } from '../../../application/upload-ports.js';
import { conflict, operationInProgress } from '../../../shared/errors.js';
import { queueDurableDeletions } from '../../orphan/outbox.js';
import { commitUploadIntents } from '../../upload-intent/repository.js';
import { queueMultipartAbortTask } from '../../multipart-abort/repository.js';
import {
	exhibitionImageRenditionReadiness,
	imageRenditionDeletionTargets,
} from '../../assets/image-rendition-lifecycle.js';
import {
	projectActiveUploadDeletionTargets,
	projectAssetDeletionTargets,
	projectWebglDeletionTargets,
} from '../project/project-deletion-targets.js';
import { parseWebglEntryKey } from '../../webgl/paths.js';
import type {
	ExhibitionDeletionOutboxConfig,
	PosterDeletionOutboxConfig,
} from './ports.js';

type TransactionClient = Prisma.TransactionClient;

type LiveExhibitionUpload = {
	id: string;
	projectId: number;
	status: 'PENDING' | 'COMPLETING' | 'VERIFYING';
	uploadKind: string;
	s3Key: string | null;
	storageKey: string | null;
	s3UploadId: string | null;
};

/**
 * PENDING sessions may own multipart parts but cannot own a completed source.
 * Parent deletion is rejected for COMPLETING/VERIFYING so their owner can
 * resolve storage ambiguity before the parent disappears.
 */
function liveUploadDeletionTargets(
	projectId: number,
	uploads: readonly LiveExhibitionUpload[],
	outbox: ExhibitionDeletionOutboxConfig,
) {
	return uploads.flatMap((upload) => [...new Set([upload.storageKey, upload.s3Key]
		.filter((key): key is string => typeof key === 'string' && key.length > 0))]
		.flatMap((key) => projectActiveUploadDeletionTargets(projectId, [{
			uploadKind: upload.uploadKind,
			s3Key: key,
		}], outbox)));
}

async function cancelLiveUploadSessions(
	tx: TransactionClient,
	sessionIds: readonly string[],
) {
	if (sessionIds.length === 0) return;
	const ids = [...new Set(sessionIds)];
	await tx.gameUploadSession.updateMany({
		where: { id: { in: ids }, status: 'PENDING' },
		data: {
			status: 'CANCELLED',
			completionClaimToken: null,
			completionClaimUntil: null,
		},
	});
}

type LockedProject = { id: number; webglEntryKey: string };

async function lockProjects(
	tx: TransactionClient,
	ids: readonly number[],
): Promise<LockedProject[]> {
	if (ids.length === 0) return [];
	return tx.$queryRaw<LockedProject[]>(Prisma.sql`
		SELECT "id", "webgl_entry_key" AS "webglEntryKey"
		FROM "projects"
		WHERE "id" IN (${Prisma.join([...new Set(ids)].sort((left, right) => left - right))})
		ORDER BY "id"
		FOR UPDATE
	`);
}

async function lockLiveUploads(
	tx: TransactionClient,
	projectIds: readonly number[],
): Promise<LiveExhibitionUpload[]> {
	if (projectIds.length === 0) return [];
	return tx.$queryRaw<LiveExhibitionUpload[]>(Prisma.sql`
		SELECT
			"id",
			"project_id" AS "projectId",
			"status",
			"upload_kind"::text AS "uploadKind",
			"s3_key" AS "s3Key",
			"storage_key" AS "storageKey",
			"s3_upload_id" AS "s3UploadId"
		FROM "game_upload_sessions"
		WHERE "project_id" IN (${Prisma.join([...new Set(projectIds)].sort((left, right) => left - right))})
			AND "status" IN ('PENDING', 'COMPLETING', 'VERIFYING')
		ORDER BY "project_id", "id"
		FOR UPDATE
	`);
}

function assertNoInFlightCompletion(uploads: readonly LiveExhibitionUpload[]): void {
	if (uploads.some((upload) => upload.status !== 'PENDING')) {
		throw operationInProgress('Exhibition deletion is blocked while an upload is completing or verifying');
	}
}

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
			// Keep project locking deterministic with project deletion/finalization.
			// The exhibition row is already locked above, so no new project can be
			// moved into this exhibition while the snapshot is established.
			const projects = await lockProjects(
				tx,
				(await tx.project.findMany({ where: { exhibitionId: id }, select: { id: true } }))
					.map((project) => project.id),
			);
			const activeUploads = await lockLiveUploads(tx, projects.map((project) => project.id));
			assertNoInFlightCompletion(activeUploads);
			const assets = await tx.asset.findMany({ where: { project: { exhibitionId: id } } });
			const completedWebglSources = projects.length === 0
				? []
				: await tx.gameUploadSession.findMany({
					where: {
						projectId: { in: projects.map((project) => project.id) },
						status: 'COMPLETED',
						uploadKind: 'WEBGL',
						storageKey: { not: null },
						webglDeploymentId: { not: null },
					},
					select: {
						projectId: true,
						webglDeploymentId: true,
						storageKey: true,
					},
				});
			const targets = [
				...(existing.posterStorageKey ? [{
					bucket: outbox.publicBucket,
					storageKey: existing.posterStorageKey,
					reason: `${outbox.reason}-poster`,
				}] : []),
				...imageRenditionDeletionTargets(
					outbox.publicBucket,
					existing.posterStorageKey,
					`${outbox.reason}-poster-rendition`,
				),
				...projectAssetDeletionTargets(assets, outbox),
				...projects.flatMap((project) => {
					const deployment = parseWebglEntryKey(project.id, project.webglEntryKey);
					const source = completedWebglSources.find((session) => (
						session.projectId === project.id
						&& session.webglDeploymentId === deployment?.deploymentId
					));
					return projectWebglDeletionTargets(
						project.id,
						project.webglEntryKey,
						outbox,
						source?.storageKey,
					);
				}),
				...projects.flatMap((project) => liveUploadDeletionTargets(
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
			await cancelLiveUploadSessions(tx, activeUploads.map((upload) => upload.id));
			await tx.gameUploadActiveSession.deleteMany({
				where: { projectId: { in: projects.map((project) => project.id) } },
			});
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
						`${outbox.reason}-rendition`,
					),
				]);
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
					...exhibitionImageRenditionReadiness(data.renditions ?? []),
				},
				include: {
					_count: { select: { projects: true } },
				},
			});
			await commitUploadIntents(tx, data.uploadIntentIds ?? []);

			return {
				updated: await tx.exhibition.findUniqueOrThrow({
					where: { id },
					include: {
						_count: { select: { projects: true } },
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
						`${outbox.reason}-rendition`,
					),
				]);
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
					posterCard480Height: null,
					posterDisplay960Height: null,
				},
				include: {
					_count: { select: { projects: true } },
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
