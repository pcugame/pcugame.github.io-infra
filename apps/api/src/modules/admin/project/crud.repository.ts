import type {
	AssetKind,
	Prisma,
	PrismaClient,
	ProjectStatus,
} from '../../../generated/prisma/client.js';
import { Prisma as PrismaRuntime } from '../../../generated/prisma/client.js';
import { operationInProgress } from '../../../shared/errors.js';
import { queueDurableDeletions } from '../../orphan/outbox.js';
import type {
	DeletionOutboxConfig,
	ProjectAssetRepository,
	ProjectCrudRepository,
	SubmitProjectRepository,
} from './ports.js';
import { createProjectAssetMutationRepository } from './asset-mutation.repository.js';
import { commitUploadIntents } from '../../upload-intent/repository.js';
import { succeedIdempotencyOperation } from '../../idempotency/repository.js';
import { queueMultipartAbortTask } from '../../multipart-abort/repository.js';
import { assetImageRenditionReadiness } from '../../assets/image-rendition-lifecycle.js';
import {
	projectActiveUploadDeletionTargets,
	projectAssetDeletionTargets,
	projectWebglDeletionTargets,
} from './project-deletion-targets.js';

type TxClient = Prisma.TransactionClient;

type LiveProjectUpload = {
	id: string;
	projectId: number;
	status: 'PENDING' | 'COMPLETING' | 'VERIFYING';
	uploadKind: string;
	s3Key: string | null;
	storageKey: string | null;
	s3UploadId: string | null;
};

/**
 * PENDING sessions have no completed object but may own multipart parts. The
 * completed states are deliberately not deleted here: callers first reject the
 * parent mutation and let the completion/verification owner resolve them.
 */
function liveUploadDeletionTargets(
	projectId: number,
	uploads: readonly LiveProjectUpload[],
	outbox: DeletionOutboxConfig,
) {
	return uploads.flatMap((upload) => [...new Set([upload.storageKey, upload.s3Key]
		.filter((key): key is string => typeof key === 'string' && key.length > 0))]
		.flatMap((key) => projectActiveUploadDeletionTargets(projectId, [{
			uploadKind: upload.uploadKind,
			s3Key: key,
		}], outbox)));
}

async function cancelLiveUploadSessions(
	tx: TxClient,
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

/**
 * Parent mutations and upload finalization lock project rows first. The order
 * is deterministic for bulk deletion and blocks a late child-session insert
 * before the live-session snapshot is taken.
 */
async function lockProjects(
	tx: TxClient,
	ids: readonly number[],
): Promise<LockedProject[]> {
	if (ids.length === 0) return [];
	return tx.$queryRaw<LockedProject[]>(PrismaRuntime.sql`
		SELECT "id", "webgl_entry_key" AS "webglEntryKey"
		FROM "projects"
		WHERE "id" IN (${PrismaRuntime.join([...new Set(ids)].sort((left, right) => left - right))})
		ORDER BY "id"
		FOR UPDATE
	`);
}

async function lockLiveUploads(
	tx: TxClient,
	projectIds: readonly number[],
): Promise<LiveProjectUpload[]> {
	if (projectIds.length === 0) return [];
	return tx.$queryRaw<LiveProjectUpload[]>(PrismaRuntime.sql`
		SELECT
			"id",
			"project_id" AS "projectId",
			"status",
			"upload_kind"::text AS "uploadKind",
			"s3_key" AS "s3Key",
			"storage_key" AS "storageKey",
			"s3_upload_id" AS "s3UploadId"
		FROM "game_upload_sessions"
		WHERE "project_id" IN (${PrismaRuntime.join([...new Set(projectIds)].sort((left, right) => left - right))})
			AND "status" IN ('PENDING', 'COMPLETING', 'VERIFYING')
		ORDER BY "project_id", "id"
		FOR UPDATE
	`);
}

function assertNoInFlightCompletion(uploads: readonly LiveProjectUpload[]): void {
	if (uploads.some((upload) => upload.status !== 'PENDING')) {
		throw operationInProgress('Project deletion is blocked while an upload is completing or verifying');
	}
}

const projectListPlayableKinds: AssetKind[] = ['GAME', 'VIDEO'];
const projectListInclude = {
	exhibition: true,
	creator: true,
	members: { orderBy: { sortOrder: 'asc' as const }, select: { name: true, studentId: true } },
	assets: {
		where: { status: 'READY' as const, kind: { in: projectListPlayableKinds } },
		select: { kind: true },
	},
	poster: {
		select: {
			kind: true,
			status: true,
			storageKey: true,
			width: true,
			height: true,
			card480Height: true,
			display960Height: true,
		},
	},
} as const satisfies Prisma.ProjectInclude;

export const projectDetailInclude = {
	exhibition: true,
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: {
		where: { status: 'READY' as const },
		orderBy: { createdAt: 'asc' as const },
	},
	poster: true,
} as const;

export type FindProjectsForUserOptions = {
	page: number;
	limit: number;
	search?: string;
	year?: number;
	status?: ProjectStatus;
	sort: 'createdAt' | 'title' | 'year' | 'status';
	order: 'asc' | 'desc';
};

function containsText(search: string): Prisma.StringFilter {
	return { contains: search, mode: 'insensitive' };
}

function buildProjectListWhere(
	userId: number,
	isPrivileged: boolean,
	options: FindProjectsForUserOptions,
): Prisma.ProjectWhereInput {
	const and: Prisma.ProjectWhereInput[] = [];
	if (!isPrivileged) {
		and.push({
			OR: [
				{ creatorId: userId },
				{ members: { some: { userId } } },
			],
		});
	}
	if (options.search) {
		and.push({
			OR: [
				{ title: containsText(options.search) },
				{ summary: containsText(options.search) },
				{ members: { some: { name: containsText(options.search) } } },
				{ members: { some: { studentId: containsText(options.search) } } },
			],
		});
	}
	if (options.year !== undefined) and.push({ exhibition: { year: options.year } });
	if (options.status !== undefined) and.push({ status: options.status });
	return and.length > 0 ? { AND: and } : {};
}

function buildProjectListOrderBy(
	sort: FindProjectsForUserOptions['sort'],
	order: FindProjectsForUserOptions['order'],
): Prisma.ProjectOrderByWithRelationInput[] {
	const primary: Prisma.ProjectOrderByWithRelationInput =
		sort === 'year' ? { exhibition: { year: order } } : { [sort]: order };
	return [primary, { id: order }];
}

function retryableTransactionError(error: unknown): boolean {
	return error instanceof PrismaRuntime.PrismaClientKnownRequestError
		&& (error.code === 'P2034' || error.code === 'P2002');
}

async function withSerializableRetry<T>(
	client: PrismaClient,
	work: (tx: TxClient) => Promise<T>,
	maxAttempts = 3,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await client.$transaction(work, {
				isolationLevel: PrismaRuntime.TransactionIsolationLevel.Serializable,
			});
		} catch (error) {
			lastError = error;
			if (!retryableTransactionError(error) || attempt === maxAttempts) throw error;
		}
	}
	throw lastError;
}

/**
 * Context-owned project CRUD repository. Every query and transaction uses only
 * the Prisma client supplied by the owning BackendContext.
 */
export function createProjectCrudRepository(client: PrismaClient): ProjectCrudRepository & {
	bulkUpdateStatus(ids: number[], status: ProjectStatus): Promise<{ count: number }>;
} & SubmitProjectRepository & ProjectAssetRepository {
	const assetMutation = createProjectAssetMutationRepository(client);

	return {
		async findProjectsForUser(userId, isPrivileged, options) {
			const where = buildProjectListWhere(userId, isPrivileged, options);
			const orderBy = buildProjectListOrderBy(options.sort, options.order);
			const [totalItems, items] = await client.$transaction([
				client.project.count({ where }),
				client.project.findMany({
					where,
					orderBy,
					skip: (options.page - 1) * options.limit,
					take: options.limit,
					include: projectListInclude,
				}),
			]);
			return { totalItems, items };
		},
		findProjectById(id) {
			return client.project.findUnique({ where: { id }, include: projectDetailInclude });
		},
		isMemberOfProject(projectId, userId) {
			return client.projectMember.findFirst({ where: { projectId, userId } });
		},
		updateProject(id, data) {
			return client.project.update({ where: { id }, data, include: projectDetailInclude });
		},
		deleteProjectReturningAssets(id, outbox) {
			return withSerializableRetry(client, async (tx) => {
				const project = (await lockProjects(tx, [id]))[0];
				if (!project) throw new Error(`Project ${id} was not found`);
				const activeUploads = await lockLiveUploads(tx, [id]);
				assertNoInFlightCompletion(activeUploads);
				const assets = await tx.asset.findMany({
					where: { projectId: id },
				});
				await queueDurableDeletions(tx, [
					...projectAssetDeletionTargets(assets, outbox),
					...projectWebglDeletionTargets(id, project.webglEntryKey, outbox),
					...liveUploadDeletionTargets(id, activeUploads, outbox),
				]);
				for (const upload of activeUploads) {
					if (!upload.s3Key || !upload.s3UploadId) continue;
					await queueMultipartAbortTask(tx, {
						bucket: outbox.protectedBucket,
						storageKey: upload.s3Key,
						uploadId: upload.s3UploadId,
						reason: `${outbox.reason}-active-multipart`,
					});
				}
				// Only PENDING rows reach here. COMPLETING/VERIFYING cause a full
				// rollback above so a late Complete cannot materialize after cleanup.
				await cancelLiveUploadSessions(tx, activeUploads.map((upload) => upload.id));
				await tx.gameUploadActiveSession.deleteMany({ where: { projectId: id } });
				await tx.project.update({
					where: { id },
					data: { posterAssetId: null },
					select: { id: true },
				});
				await tx.asset.deleteMany({ where: { projectId: id } });
				await tx.project.delete({ where: { id } });
				return { assets, webglEntryKey: project.webglEntryKey, activeUploads };
			});
		},
		clearWebglDeployment(projectId, outbox) {
			return withSerializableRetry(client, async (tx) => {
				const project = (await lockProjects(tx, [projectId]))[0];
				if (!project) throw new Error(`Project ${projectId} was not found`);
				const liveUploads = await lockLiveUploads(tx, [projectId]);
				const liveWebglUploads = liveUploads.filter((upload) => upload.uploadKind === 'WEBGL');
				assertNoInFlightCompletion(liveWebglUploads);
				const active = await tx.gameUploadActiveSession.findUnique({
					where: { projectId_uploadKind: { projectId, uploadKind: 'WEBGL' } },
					include: { session: true },
				});
				await queueDurableDeletions(tx, [
					...projectWebglDeletionTargets(projectId, project.webglEntryKey, outbox),
					...liveUploadDeletionTargets(projectId, liveWebglUploads, outbox),
				]);
				for (const upload of liveWebglUploads) {
					if (!upload.s3Key || !upload.s3UploadId) continue;
					await queueMultipartAbortTask(tx, {
						bucket: outbox.protectedBucket,
						storageKey: upload.s3Key,
						uploadId: upload.s3UploadId,
						reason: `${outbox.reason}-active-multipart`,
					});
				}
				await cancelLiveUploadSessions(tx, liveWebglUploads.map((upload) => upload.id));
				await tx.gameUploadActiveSession.deleteMany({
					where: { projectId, uploadKind: 'WEBGL' },
				});
				await tx.project.update({ where: { id: projectId }, data: { webglEntryKey: '' } });
				return { oldEntryKey: project.webglEntryKey, cancelledSession: active?.session ?? liveWebglUploads[0] ?? null };
			});
		},
		findAssetById(id) {
			return client.asset.findUnique({ where: { id } });
		},
		setProjectPoster(projectId, assetId) {
			return assetMutation.setProjectPoster(projectId, assetId);
		},
		bulkDeleteProjectsReturningAssets(ids, outbox) {
			return withSerializableRetry(client, async (tx) => {
				const projects = await lockProjects(tx, ids);
				const activeUploads = await lockLiveUploads(tx, projects.map((project) => project.id));
				assertNoInFlightCompletion(activeUploads);
				const assets = await tx.asset.findMany({
					where: { projectId: { in: ids } },
				});
				await queueDurableDeletions(tx, [
					...projectAssetDeletionTargets(assets, outbox),
					...projects.flatMap((project) => projectWebglDeletionTargets(
						project.id,
						project.webglEntryKey,
						outbox,
					)),
					...projects.flatMap((project) => liveUploadDeletionTargets(
						project.id,
						activeUploads.filter((upload) => upload.projectId === project.id),
						outbox,
					)),
				]);
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
				await tx.gameUploadActiveSession.deleteMany({ where: { projectId: { in: ids } } });
				await tx.project.updateMany({
					where: { id: { in: ids } },
					data: { posterAssetId: null },
				});
				await tx.asset.deleteMany({ where: { projectId: { in: ids } } });
				const result = await tx.project.deleteMany({ where: { id: { in: ids } } });
				return { result, assets, projects, activeUploads };
			});
		},
		bulkUpdateStatus(ids, status) {
			return client.project.updateMany({ where: { id: { in: ids } }, data: { status } });
		},
		findExhibitionById(id) {
			return client.exhibition.findUnique({ where: { id } });
		},
		findProjectByExhibitionAndSlug(exhibitionId, slug) {
			return client.project.findUnique({
				where: { project_exhibition_slug: { exhibitionId, slug } },
			});
		},
		createProjectWithAssets(data) {
			return client.$transaction(async (tx) => {
				const project = await tx.project.create({
					data: {
						exhibitionId: data.exhibitionId,
						slug: data.slug,
						title: data.title,
						summary: data.summary,
						description: data.description,
						status: data.status,
						creatorId: data.creatorId,
						members: {
							create: data.members.map((member, index) => ({
								name: member.name,
								studentId: member.studentId,
								sortOrder: member.sortOrder ?? index,
								...(member.userId ? { userId: member.userId } : {}),
							})),
						},
					},
				});

				let posterAssetId: number | null = null;
				for (const savedFile of data.savedFiles) {
					const asset = await tx.asset.create({
						data: {
							projectId: project.id,
							kind: savedFile.kind,
							storageKey: savedFile.storageKey,
							playbackStorageKey: savedFile.playbackStorageKey ?? null,
							originalName: savedFile.originalName,
							mimeType: savedFile.mimeType,
							playbackMimeType: savedFile.playbackMimeType ?? '',
							sizeBytes: BigInt(savedFile.sizeBytes),
							playbackSizeBytes: BigInt(savedFile.playbackSizeBytes ?? 0),
							playbackStatus: savedFile.playbackStatus ?? 'PENDING',
							playbackError: savedFile.playbackError ?? '',
							isPublic: savedFile.kind !== 'GAME' && savedFile.kind !== 'VIDEO',
							width: savedFile.width,
							height: savedFile.height,
							...assetImageRenditionReadiness(savedFile.renditions ?? []),
						},
					});
					if (savedFile.kind === 'POSTER' && posterAssetId === null) {
						posterAssetId = asset.id;
					}
				}
				if (posterAssetId !== null) {
					await tx.project.update({
						where: { id: project.id },
						data: { posterAssetId },
					});
				}
				await commitUploadIntents(
					tx,
					data.savedFiles.flatMap((savedFile) => savedFile.uploadIntentIds ?? []),
				);
				if (data.idempotency) {
					await succeedIdempotencyOperation(tx, {
						operationId: data.idempotency.operationId,
						ownerToken: data.idempotency.ownerToken,
						result: data.idempotency.resultForProject(project),
					});
				}
				return project;
			});
		},
		createAsset(data) {
			return client.$transaction(async (tx) => {
				const {
					uploadIntentIds = [],
					idempotency,
					renditions = [],
					...assetData
				} = data;
				const asset = await tx.asset.create({
					data: {
						...assetData,
						...assetImageRenditionReadiness(renditions),
					},
				});
				await commitUploadIntents(tx, uploadIntentIds);
				if (idempotency) {
					await succeedIdempotencyOperation(tx, {
						operationId: idempotency.operationId,
						ownerToken: idempotency.ownerToken,
						result: idempotency.resultForAsset(asset.id),
					});
				}
				return asset;
			});
		},
		replaceOrCreateReplaceableAsset(projectId, kind, data, outbox) {
			return assetMutation.replaceOrCreateReplaceableAsset(
				projectId,
				kind,
				data,
				outbox,
			);
		},
	};
}
