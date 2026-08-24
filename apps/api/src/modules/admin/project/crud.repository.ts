import type {
	AssetKind,
	Prisma,
	PrismaClient,
	ProjectStatus as PrismaProjectStatus,
} from '../../../generated/prisma/client.js';
import type { ProjectStatus } from '@pcu/contracts';
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
import { createCanonicalAsset } from '../../assets/representation-write.js';
import { parseWebglEntryKey } from '../../webgl/paths.js';
import { conflict } from '../../../shared/errors.js';
import {
	projectActiveUploadDeletionTargets,
	projectAssetDeletionTargets,
	projectWebglDeletionTargets,
} from './project-deletion-targets.js';

type TxClient = Prisma.TransactionClient;

function phase1ProjectStatus<T extends { status: PrismaProjectStatus }>(project: T): Omit<T, 'status'> & { status: ProjectStatus } {
	if (project.status === 'DRAFT') {
		throw conflict('DRAFT projects require the Phase 2 publication runtime');
	}
	return { ...project, status: project.status };
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
			representations: {
				where: { state: 'READY' as const },
				select: { role: true, objectKey: true, mimeType: true, width: true, height: true },
			},
		},
	},
} as const satisfies Prisma.ProjectInclude;

export const projectDetailInclude = {
	exhibition: true,
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: {
		where: { status: 'READY' as const },
		orderBy: { createdAt: 'asc' as const },
		include: { representations: { where: { state: 'READY' as const } } },
	},
	poster: { include: { representations: { where: { state: 'READY' as const } } } },
	currentWebglDeployment: true,
} as const;

const webglDeletionSnapshotSelect = {
	id: true,
	projectId: true,
	publicBucket: true,
	publicPrefix: true,
	entryObjectKey: true,
	objectManifest: true,
	sourceRepresentation: {
		select: { id: true, assetId: true, role: true, bucket: true, objectKey: true },
	},
} as const satisfies Prisma.WebglDeploymentSelect;

const canonicalActiveUploadStates = ['ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING'] as const;

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
export function createProjectCrudRepository(
	client: PrismaClient,
	buckets: { publicBucket: string; protectedBucket: string } = {
		publicBucket: 'pcu-public',
		protectedBucket: 'pcu-protected',
	},
): ProjectCrudRepository & {
	bulkUpdateStatus(ids: number[], status: ProjectStatus): Promise<{ count: number }>;
} & SubmitProjectRepository & ProjectAssetRepository {
	const assetMutation = createProjectAssetMutationRepository(client);

	async function recordLegacyWebglFallback(project: {
		id: number;
		webglEntryKey: string;
		currentWebglDeploymentId: string | null;
	}): Promise<void> {
		if (project.currentWebglDeploymentId !== null
			|| !parseWebglEntryKey(project.id, project.webglEntryKey)) return;
		await client.migrationMetric.upsert({
			where: {
				name_scope: {
					name: 'public_webgl_legacy_fallback',
					scope: 'admin-project-response',
				},
			},
			create: {
				name: 'public_webgl_legacy_fallback',
				scope: 'admin-project-response',
				value: 1n,
				lastObservedAt: new Date(),
				details: { projectId: project.id },
			},
			update: {
				value: { increment: 1n },
				lastObservedAt: new Date(),
				details: { projectId: project.id },
			},
		});
	}

	function canonicalUploadCleanup(upload: {
		id: string;
		projectId: number | null;
		kind: string;
		objectKey: string;
		uploadId: string | null;
	}) {
		if (upload.projectId === null) {
			throw new Error(`Canonical WEBGL upload ${upload.id} is not project-owned`);
		}
		return {
			id: upload.id,
			projectId: upload.projectId,
			uploadKind: upload.kind,
			s3Key: upload.objectKey,
			s3UploadId: upload.uploadId,
			canonicalSessionId: upload.id,
		};
	}

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
			return { totalItems, items: items.map(phase1ProjectStatus) };
		},
		async findProjectById(id) {
			const project = await client.project.findUnique({ where: { id }, include: projectDetailInclude });
			if (project) await recordLegacyWebglFallback(project);
			return project ? phase1ProjectStatus(project) : null;
		},
		isMemberOfProject(projectId, userId) {
			return client.projectMember.findFirst({ where: { projectId, userId } });
		},
		async updateProject(id, data) {
			const project = await client.project.update({ where: { id }, data, include: projectDetailInclude });
			await recordLegacyWebglFallback(project);
			return phase1ProjectStatus(project);
		},
		deleteProjectReturningAssets(id, outbox) {
			return client.$transaction(async (tx) => {
				await tx.$queryRaw(PrismaRuntime.sql`
					SELECT "id" FROM "projects" WHERE "id" = ${id} FOR UPDATE
				`);
				const project = await tx.project.findUniqueOrThrow({
					where: { id },
					select: {
						webglEntryKey: true,
						currentWebglDeploymentId: true,
						webglDeployments: { select: webglDeletionSnapshotSelect },
					},
				});
				const legacyActiveUploads = await tx.gameUploadSession.findMany({
					where: { projectId: id, status: { in: ['PENDING', 'COMPLETING'] } },
					select: { id: true, uploadKind: true, s3Key: true, s3UploadId: true },
				});
				const canonicalActiveUploads = await tx.assetUploadSession.findMany({
					where: { projectId: id, kind: 'WEBGL', state: { in: [...canonicalActiveUploadStates] } },
					select: { id: true, projectId: true, kind: true, objectKey: true, uploadId: true },
				});
				const activeUploads = [
					...legacyActiveUploads,
					...canonicalActiveUploads.map(canonicalUploadCleanup),
				];
				const assets = await tx.asset.findMany({
					where: { projectId: id },
					include: { representations: true },
				});
				await queueDurableDeletions(tx, [
					...projectAssetDeletionTargets(assets, outbox),
					...projectWebglDeletionTargets(
						id,
						project.webglEntryKey,
						outbox,
						project.webglDeployments,
					),
					...projectActiveUploadDeletionTargets(id, activeUploads, outbox),
				]);
				for (const upload of activeUploads) {
					if (!upload.s3Key || !upload.s3UploadId) continue;
					await queueMultipartAbortTask(tx, {
						bucket: outbox.protectedBucket,
						storageKey: upload.s3Key,
						uploadId: upload.s3UploadId,
						reason: `${outbox.reason}-active-multipart`,
						...('canonicalSessionId' in upload
							? { uploadSessionId: upload.canonicalSessionId }
							: {}),
					});
				}
				await tx.assetUploadSession.deleteMany({ where: { projectId: id } });
				await tx.project.update({
					where: { id },
					data: { posterAssetId: null, currentWebglDeploymentId: null },
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
					select: {
						webglEntryKey: true,
						currentWebglDeploymentId: true,
						webglDeployments: { select: webglDeletionSnapshotSelect },
					},
				});
				const legacyActive = await tx.gameUploadActiveSession.findUnique({
					where: { projectId_uploadKind: { projectId, uploadKind: 'WEBGL' } },
					include: { session: true },
				});
				const canonicalActive = await tx.assetUploadSession.findMany({
					where: {
						projectId,
						kind: 'WEBGL',
						state: { in: [...canonicalActiveUploadStates] },
					},
					select: { id: true, projectId: true, kind: true, objectKey: true, uploadId: true },
				});
				const activeUploads = [
					...(legacyActive?.session ? [legacyActive.session] : []),
					...canonicalActive.map(canonicalUploadCleanup),
				];
				await queueDurableDeletions(tx, [
					...projectWebglDeletionTargets(
						projectId,
						project.webglEntryKey,
						outbox,
						project.webglDeployments,
					),
					...projectActiveUploadDeletionTargets(projectId, activeUploads, outbox),
				]);
				for (const upload of activeUploads) {
					if (!upload.s3Key || !upload.s3UploadId) continue;
					await queueMultipartAbortTask(tx, {
						bucket: outbox.protectedBucket,
						storageKey: upload.s3Key,
						uploadId: upload.s3UploadId,
						reason: `${outbox.reason}-active-multipart`,
						...('canonicalSessionId' in upload
							? { uploadSessionId: upload.canonicalSessionId }
							: {}),
					});
				}
				if (legacyActive) {
					await tx.gameUploadSession.updateMany({
						where: { id: legacyActive.sessionId, status: { in: ['PENDING', 'COMPLETING'] } },
						data: { status: 'CANCELLED' },
					});
					await tx.gameUploadActiveSession.deleteMany({ where: { sessionId: legacyActive.sessionId } });
				}
				if (canonicalActive.length > 0) {
					await tx.assetUploadSession.updateMany({
						where: { id: { in: canonicalActive.map(({ id }) => id) }, state: { in: [...canonicalActiveUploadStates] } },
						data: {
							state: 'CANCELLED',
							completionLeaseToken: null,
							completionLeaseUntil: null,
							validationLeaseToken: null,
							validationLeaseUntil: null,
						},
					});
				}
				const pointerCleared = await tx.project.updateMany({
					where: {
						id: projectId,
						currentWebglDeploymentId: project.currentWebglDeploymentId,
					},
					data: { currentWebglDeploymentId: null, webglEntryKey: '' },
				});
				if (pointerCleared.count !== 1) throw conflict('WebGL deployment changed concurrently');
				const sourceRepresentationIds = project.webglDeployments.map(
					({ sourceRepresentation }) => sourceRepresentation.id,
				);
				const sourceAssetIds = project.webglDeployments.map(
					({ sourceRepresentation }) => sourceRepresentation.assetId,
				);
				await tx.webglDeployment.deleteMany({ where: { projectId } });
				if (sourceRepresentationIds.length > 0) {
					await tx.assetRepresentation.deleteMany({
						where: { id: { in: sourceRepresentationIds }, role: 'WEBGL_SOURCE' },
					});
					await tx.asset.deleteMany({
						where: {
							id: { in: sourceAssetIds },
							projectId,
							kind: 'WEBGL',
							representations: { none: {} },
						},
					});
				}
				return {
					oldEntryKey: project.webglEntryKey,
					cancelledSession: activeUploads[0] ?? null,
				};
			});
		},
		async findAssetById(id) {
			const asset = await client.asset.findUnique({
				where: { id },
				select: { id: true, projectId: true, kind: true, status: true },
			});
			if (asset?.projectId == null) return null;
			return {
				id: asset.id,
				projectId: asset.projectId,
				kind: asset.kind,
				status: asset.status,
			};
		},
		setProjectPoster(projectId, assetId) {
			return assetMutation.setProjectPoster(projectId, assetId);
		},
		bulkDeleteProjectsReturningAssets(ids, outbox) {
			return client.$transaction(async (tx) => {
				if (ids.length > 0) {
					await tx.$queryRaw(PrismaRuntime.sql`
						SELECT "id" FROM "projects"
						WHERE "id" IN (${PrismaRuntime.join(ids)})
						ORDER BY "id"
						FOR UPDATE
					`);
				}
				const projects = await tx.project.findMany({
					where: { id: { in: ids } },
					select: {
						id: true,
						webglEntryKey: true,
						currentWebglDeploymentId: true,
						webglDeployments: { select: webglDeletionSnapshotSelect },
					},
				});
				const legacyActiveUploads = await tx.gameUploadSession.findMany({
					where: { projectId: { in: ids }, status: { in: ['PENDING', 'COMPLETING'] } },
					select: { id: true, projectId: true, uploadKind: true, s3Key: true, s3UploadId: true },
				});
				const canonicalActiveUploads = await tx.assetUploadSession.findMany({
					where: {
						projectId: { in: ids },
						kind: 'WEBGL',
						state: { in: [...canonicalActiveUploadStates] },
					},
					select: { id: true, projectId: true, kind: true, objectKey: true, uploadId: true },
				});
				const activeUploads = [
					...legacyActiveUploads,
					...canonicalActiveUploads.map(canonicalUploadCleanup),
				];
				const assets = await tx.asset.findMany({
					where: { projectId: { in: ids } },
					include: { representations: true },
				});
				await queueDurableDeletions(tx, [
					...projectAssetDeletionTargets(assets, outbox),
					...projects.flatMap((project) => projectWebglDeletionTargets(
						project.id,
						project.webglEntryKey,
						outbox,
						project.webglDeployments,
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
						...('canonicalSessionId' in upload
							? { uploadSessionId: upload.canonicalSessionId }
							: {}),
					});
				}
				await tx.assetUploadSession.deleteMany({ where: { projectId: { in: ids } } });
				await tx.project.updateMany({
					where: { id: { in: ids } },
					data: { posterAssetId: null, currentWebglDeploymentId: null },
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
					const asset = await createCanonicalAsset(tx, {
						projectId: project.id,
						kind: savedFile.kind,
						bucket: savedFile.bucket ?? (
							savedFile.kind === 'GAME' || savedFile.kind === 'VIDEO'
								? buckets.protectedBucket
								: buckets.publicBucket
						),
						storageKey: savedFile.storageKey,
						playbackStorageKey: savedFile.playbackStorageKey,
						originalName: savedFile.originalName,
						mimeType: savedFile.mimeType,
						playbackMimeType: savedFile.playbackMimeType,
						sizeBytes: BigInt(savedFile.sizeBytes),
						playbackSizeBytes: BigInt(savedFile.playbackSizeBytes ?? 0),
						playbackStatus: savedFile.playbackStatus,
						playbackError: savedFile.playbackError,
						isPublic: savedFile.kind !== 'GAME' && savedFile.kind !== 'VIDEO',
						width: savedFile.width,
						height: savedFile.height,
						renditions: savedFile.renditions,
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
				const asset = await createCanonicalAsset(tx, {
					...assetData,
					bucket: assetData.bucket
						?? (assetData.isPublic ? buckets.publicBucket : buckets.protectedBucket),
					renditions,
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
