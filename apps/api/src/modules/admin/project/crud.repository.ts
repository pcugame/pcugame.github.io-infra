import type {
	AssetKind,
	Prisma,
	PrismaClient,
	ProjectStatus,
} from '../../../generated/prisma/client.js';
import { Prisma as PrismaRuntime } from '../../../generated/prisma/client.js';
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
import { imageRenditionCreateManyData } from '../../assets/image-rendition-lifecycle.js';
import {
	projectActiveUploadDeletionTargets,
	projectAssetDeletionTargets,
	projectWebglDeletionTargets,
} from './project-deletion-targets.js';

type TxClient = Prisma.TransactionClient;

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
			imageRenditions: true,
		},
	},
} as const satisfies Prisma.ProjectInclude;

export const projectDetailInclude = {
	exhibition: true,
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: {
		where: { status: 'READY' as const },
		orderBy: { createdAt: 'asc' as const },
		include: { imageRenditions: true },
	},
	poster: { include: { imageRenditions: true } },
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
			return client.$transaction(async (tx) => {
				const project = await tx.project.findUniqueOrThrow({
					where: { id },
					select: { webglEntryKey: true },
				});
				const activeUploads = await tx.gameUploadSession.findMany({
					where: { projectId: id, status: { in: ['PENDING', 'COMPLETING'] } },
					select: { id: true, uploadKind: true, s3Key: true, s3UploadId: true },
				});
				const assets = await tx.asset.findMany({
					where: { projectId: id },
					include: { imageRenditions: true },
				});
				await queueDurableDeletions(tx, [
					...projectAssetDeletionTargets(assets, outbox),
					...projectWebglDeletionTargets(id, project.webglEntryKey, outbox),
					...projectActiveUploadDeletionTargets(id, activeUploads, outbox),
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
				const project = await tx.project.findUniqueOrThrow({
					where: { id: projectId },
					select: { webglEntryKey: true },
				});
				const active = await tx.gameUploadActiveSession.findUnique({
					where: { projectId_uploadKind: { projectId, uploadKind: 'WEBGL' } },
					include: { session: true },
				});
				await queueDurableDeletions(tx, [
					...projectWebglDeletionTargets(projectId, project.webglEntryKey, outbox),
					...projectActiveUploadDeletionTargets(projectId, active?.session ? [active.session] : [], outbox),
				]);
				if (active?.session.s3Key && active.session.s3UploadId) {
					await queueMultipartAbortTask(tx, {
						bucket: outbox.protectedBucket,
						storageKey: active.session.s3Key,
						uploadId: active.session.s3UploadId,
						reason: `${outbox.reason}-active-multipart`,
					});
				}
				if (active) {
					await tx.gameUploadSession.updateMany({
						where: { id: active.sessionId, status: { in: ['PENDING', 'COMPLETING'] } },
						data: { status: 'CANCELLED' },
					});
					await tx.gameUploadActiveSession.deleteMany({ where: { sessionId: active.sessionId } });
				}
				await tx.project.update({ where: { id: projectId }, data: { webglEntryKey: '' } });
				return { oldEntryKey: project.webglEntryKey, cancelledSession: active?.session ?? null };
			});
		},
		findAssetById(id) {
			return client.asset.findUnique({ where: { id } });
		},
		setProjectPoster(projectId, assetId) {
			return assetMutation.setProjectPoster(projectId, assetId);
		},
		bulkDeleteProjectsReturningAssets(ids, outbox) {
			return client.$transaction(async (tx) => {
				const projects = await tx.project.findMany({
					where: { id: { in: ids } },
					select: { id: true, webglEntryKey: true },
				});
				const activeUploads = await tx.gameUploadSession.findMany({
					where: { projectId: { in: ids }, status: { in: ['PENDING', 'COMPLETING'] } },
					select: { id: true, projectId: true, uploadKind: true, s3Key: true, s3UploadId: true },
				});
				const assets = await tx.asset.findMany({
					where: { projectId: { in: ids } },
					include: { imageRenditions: true },
				});
				await queueDurableDeletions(tx, [
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
						},
					});
					const renditionData = imageRenditionCreateManyData(
						{ assetId: asset.id },
						savedFile.storageKey,
						savedFile.renditions ?? [],
					);
					if (renditionData.length > 0) {
						await tx.imageRendition.createMany({ data: renditionData });
					}
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
				const asset = await tx.asset.create({ data: assetData });
				const renditionData = imageRenditionCreateManyData(
					{ assetId: asset.id },
					data.storageKey,
					renditions,
				);
				if (renditionData.length > 0) {
					await tx.imageRendition.createMany({ data: renditionData });
				}
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
