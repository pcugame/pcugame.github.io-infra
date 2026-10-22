import { changePublication, publicationSnapshotInclude } from './publication.repository.js';
import { assertPublication, assertPublicationNotWorsened } from '../../../shared/publication-policy.js';
import { canReadVisibility, isVisibilityStaff } from '../../../shared/visibility.js';
import { getProjectVideos, rewriteProjectVideoOrder, MAX_PROJECT_VIDEOS } from '../../assets/video-order.js';
import { withAssetMutationTransaction } from '../../assets/mutation-transaction.js';
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
	ProjectCrudRepository,
	SubmitProjectRepository,
} from './ports.js';
import { succeedIdempotencyOperation } from '../../idempotency/repository.js';
import { queueMultipartAbortTask } from '../../multipart-abort/repository.js';
import { AppError, conflict, forbidden, notFound } from '../../../shared/errors.js';
import { assertValidPosterAsset } from '../../../shared/poster-validation.js';
import {
	projectActiveUploadDeletionTargets,
	projectAssetDeletionTargets,
	projectWebglDeletionTargets,
} from './project-deletion-targets.js';
import {
	createProjectPublicationPlan,
} from '../../project-publication/plan.js';
import { assertProjectWriteAccessInTransaction } from '../project-access.service.js';
import { cleanupSourceChangeRequests } from '../../project-change/transaction.js';
import type { Actor } from '../../../application/http-input.js';

type TxClient = Prisma.TransactionClient;

async function guardMutation(tx: TxClient, actor: Actor | undefined, projectId: number): Promise<void> {
	if (actor) {
		await assertProjectWriteAccessInTransaction(tx, actor, projectId);
		return;
	}
	const rows = await tx.$queryRaw<Array<{ id: number }>>(PrismaRuntime.sql`
		SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE
	`);
	if (!rows.length) throw notFound('Project not found');
}

const projectListPlayableKinds: AssetKind[] = ['GAME', 'VIDEO'];
const projectAssetActivityInclude = {
	assetUploads: {
		where: { kind: { in: ['GAME', 'WEBGL', 'VIDEO', 'POSTER'] } },
		// Keep active sessions and the newest terminal attempt without returning upload history.
		distinct: ['kind', 'state'],
		orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
		select: { kind: true, state: true },
	},
	publicationJob: { select: {
		state: true,
		submission: { select: { items: { select: { kind: true, state: true } } } },
	} },
} satisfies Prisma.ProjectInclude;
const projectListInclude = {
	...projectAssetActivityInclude,
	currentWebglDeployment: { select: {
		id: true, projectId: true, state: true,
		publicBucket: true, publicPrefix: true, entryObjectKey: true,
	} },
	exhibition: true,
	creator: true,
	members: { orderBy: { sortOrder: 'asc' as const }, select: { name: true, studentId: true, userId: true } },
	assets: {
		where: { status: 'READY' as const, kind: { in: projectListPlayableKinds } },
		select: { kind: true, representations: { select: { role: true, state: true } } },
	},
	poster: {
		select: {
			kind: true,
			status: true,
			representations: {
				where: { state: 'READY' as const },
				select: {
					role: true,
					bucket: true,
					objectKey: true,
					mimeType: true,
					state: true,
					sizeBytes: true,
					width: true,
					height: true,
				},
			},
		},
	},
} as const satisfies Prisma.ProjectInclude;

export const projectDetailInclude = {
	...projectAssetActivityInclude,
	exhibition: true,
	changeRequestDraft: { select: { id: true } },
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: {
		where: { status: 'READY' as const },
		orderBy: { createdAt: 'asc' as const },
		include: { representations: true, playbackJobs: { orderBy: { createdAt: 'desc' as const }, include: { renditions: true } } },
	},
	poster: { include: { representations: { where: { state: 'READY' as const } } } },
	currentWebglDeployment: true,
} as const;

const projectSubmissionInclude = {
	project: { select: { id: true, status: true } },
	publicationJob: { select: { state: true, lastError: true } },
	items: {
  where: { required: true },
		orderBy: { slot: 'asc' as const },
		include: { uploadSession: { select: {
			id: true, generation: true, sourceIdentityAlgorithm: true, sourceIdentity: true,
		} } },
	},
} as const satisfies Prisma.ProjectSubmissionInclude;

const webglDeletionSnapshotSelect = {
	id: true,
	projectId: true,
	publicBucket: true,
	publicPrefix: true,
	entryObjectKey: true,
	objectManifest: true,
	stagingBucket: true,
	stagingPrefix: true,
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

function searchTokens(search: string): string[] {
	const tokens = new Map<string, string>();
	for (const token of search.trim().split(/\s+/)) {
		if (token) tokens.set(token.toLowerCase(), token);
	}
	return [...tokens.values()];
}

function isCanonicalYearToken(token: string): boolean {
	return /^[1-9]\d{3}$/.test(token);
}

function searchTokenWhere(token: string): Prisma.ProjectWhereInput {
	const or: Prisma.ProjectWhereInput[] = [
		{ title: containsText(token) },
		{ summary: containsText(token) },
		{ members: { some: { name: containsText(token) } } },
		{ members: { some: { studentId: containsText(token) } } },
		{ exhibition: { title: containsText(token) } },
	];
	if (isCanonicalYearToken(token)) or.push({ exhibition: { year: Number(token) } });
	return { OR: or };
}

function buildProjectListWhere(
	userId: number,
	isPrivileged: boolean,
	options: FindProjectsForUserOptions,
): Prisma.ProjectWhereInput {
	const and: Prisma.ProjectWhereInput[] = [{ changeRequestDraft: null, hiddenCancelled: false }];
	if (!isPrivileged) {
		and.push({
			OR: [
				{ creatorId: userId },
				{ members: { some: { userId } } },
			],
		});
	}
	if (options.search) and.push(...searchTokens(options.search).map(searchTokenWhere));
	if (options.year !== undefined) and.push({ exhibition: { year: options.year } });
	if (options.status !== undefined) and.push({ publicationStatus: options.status === 'PUBLISHED' ? 'PUBLIC' : 'PRIVATE' });
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
	if (!error || typeof error !== 'object') return false;
	const candidate = error as { code?: unknown; meta?: unknown; message?: unknown };
	if (candidate.code === 'P2034' || candidate.code === 'P2002') return true;
	if (candidate.code === 'P2010' && candidate.meta && typeof candidate.meta === 'object'
		&& (candidate.meta as { code?: unknown }).code === '40001') return true;
	return typeof candidate.message === 'string'
		&& candidate.message.includes('Code: `40001`');
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
	} & SubmitProjectRepository {

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
			objectKey: upload.objectKey,
			uploadId: upload.uploadId,
			canonicalSessionId: upload.id,
		};
	}

	async function assertSubmissionActor(
		submission: { actorId: number; projectId: number },
		actor: { id: number; role: string },
  connection: Pick<PrismaClient, 'projectMember'> = client,
	): Promise<void> {
		if (actor.role !== 'ADMIN' && actor.role !== 'OPERATOR' && submission.actorId !== actor.id && !await connection.projectMember.findFirst({ where: { projectId: submission.projectId, userId: actor.id } })) {
			throw forbidden('Project submission is owned by another user');
		}
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
			return { totalItems, items };
		},
		async findProjectById(id) {
			return client.project.findUnique({ where: { id }, include: projectDetailInclude });
		},
		isMemberOfProject(projectId, userId) {
			return client.projectMember.findFirst({ where: { projectId, userId } });
		},
		async updateProject(id, data, actor) {
   return client.$transaction(async (tx) => {
    await guardMutation(tx, actor, id);
    const before = await tx.project.findUniqueOrThrow({ where: { id }, include: publicationSnapshotInclude });
    const { publication, status, visibility, ...metadata } = data;
    await tx.project.update({ where: { id }, data: { ...metadata, ...(Object.keys(metadata).length ? { publicationRequested: false } : {}) } });
    // Legacy clients still pass status/visibility; route them through the same policy.
    const command = publication ?? (status !== undefined || visibility !== undefined ? {
     status: visibility === 'STAFF' || status === 'DRAFT' || status === 'ARCHIVED' ? 'PRIVATE' as const : 'PUBLIC' as const,
     expectedVersion: before.version,
    } : undefined);
    if (command) {
     if (!actor) throw forbidden('Authenticated publication actor required');
     await changePublication(tx, id, command, actor);
    }
    const after = await tx.project.findUniqueOrThrow({ where: { id }, include: publicationSnapshotInclude });
    if (before.publicationStatus === 'PUBLIC' && after.publicationStatus === 'PUBLIC') assertPublicationNotWorsened(before, after);
    await tx.project.update({ where: { id }, data: { version: { increment: 1 } } });
    return tx.project.findUniqueOrThrow({ where: { id }, include: projectDetailInclude });
   });
  },
		deleteProjectReturningAssets(id, outbox, actor) {
			return client.$transaction(async (tx) => {
				await guardMutation(tx, actor, id);
				await cleanupSourceChangeRequests(tx, id);
				const project = await tx.project.findUniqueOrThrow({
					where: { id },
					select: {
						webglDeployments: { select: webglDeletionSnapshotSelect },
					},
				});
				const canonicalActiveUploads = await tx.assetUploadSession.findMany({
					where: { projectId: id, state: { in: [...canonicalActiveUploadStates] } },
					select: { id: true, projectId: true, kind: true, objectKey: true, uploadId: true },
				});
				const activeUploads = canonicalActiveUploads.map(canonicalUploadCleanup);
				const assets = await tx.asset.findMany({
					where: { projectId: id },
					include: { representations: true },
				});
				await queueDurableDeletions(tx, [
					...projectAssetDeletionTargets(assets, outbox),
					...projectWebglDeletionTargets(
						id,
						outbox,
						project.webglDeployments,
					),
					...projectActiveUploadDeletionTargets(id, activeUploads, outbox),
				]);
				for (const upload of activeUploads) {
					if (!upload.objectKey || !upload.uploadId) continue;
					await queueMultipartAbortTask(tx, {
						bucket: outbox.protectedBucket,
						storageKey: upload.objectKey,
						uploadId: upload.uploadId,
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
				return { assets, activeUploads };
			});
		},
		clearWebglDeployment(projectId, outbox, actor) {
			return withSerializableRetry(client, async (tx) => {
				await guardMutation(tx, actor, projectId);
				const project = await tx.project.findUniqueOrThrow({
					where: { id: projectId },
					select: {
						currentWebglDeploymentId: true,
						webglDeployments: { select: webglDeletionSnapshotSelect },
					},
				});
				const canonicalActive = await tx.assetUploadSession.findMany({
					where: {
						projectId,
						kind: 'WEBGL',
						state: { in: [...canonicalActiveUploadStates] },
					},
					select: { id: true, projectId: true, kind: true, objectKey: true, uploadId: true },
				});
				const activeUploads = canonicalActive.map(canonicalUploadCleanup);
				await queueDurableDeletions(tx, [
					...projectWebglDeletionTargets(
						projectId,
						outbox,
						project.webglDeployments,
					),
					...projectActiveUploadDeletionTargets(projectId, activeUploads, outbox),
				]);
				for (const upload of activeUploads) {
					if (!upload.objectKey || !upload.uploadId) continue;
					await queueMultipartAbortTask(tx, {
						bucket: outbox.protectedBucket,
						storageKey: upload.objectKey,
						uploadId: upload.uploadId,
						reason: `${outbox.reason}-active-multipart`,
						...('canonicalSessionId' in upload
							? { uploadSessionId: upload.canonicalSessionId }
							: {}),
					});
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
					data: { currentWebglDeploymentId: null },
				});
				if (pointerCleared.count !== 1) throw conflict('WebGL deployment changed concurrently');
				await tx.project.update({ where: { id: projectId }, data: { version: { increment: 1 } } });
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
		setProjectVideoOrder(projectId, expectedOrder, order, actor) {
			return withAssetMutationTransaction(client, async (tx) => {
				await guardMutation(tx, actor, projectId);
				const submission = await tx.projectSubmission.findUnique({ where: { projectId }, select: { state: true } });
				if (submission && ['PENDING', 'FINALIZING'].includes(submission.state)) {
					throw conflict('Submission videos cannot be reordered before publication');
				}
				const videos = await getProjectVideos(tx, projectId);
				const current = videos.map(({ id }) => id);
				if (current.length > MAX_PROJECT_VIDEOS) throw conflict('Project exceeds the five video limit');
				if (expectedOrder.length !== current.length || expectedOrder.some((id, index) => id !== current[index])) {
					throw conflict('Video order changed; refresh and try again');
				}
				if (order.length !== current.length || new Set(order).size !== current.length || order.some((id) => !current.includes(id))) {
					throw conflict('Order must contain every current video exactly once');
				}
				await rewriteProjectVideoOrder(tx, projectId, order);
				await tx.project.update({ where: { id: projectId }, data: { version: { increment: 1 } } });
				return { order };
			});
		},
		async setProjectPoster(projectId, assetId, actor) {
			return client.$transaction(async (tx) => {
				await guardMutation(tx, actor, projectId);
				const before = await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: publicationSnapshotInclude });
				const asset = await tx.asset.findUnique({
					where: { id: assetId },
					select: { id: true, projectId: true, kind: true, status: true },
				});
				assertValidPosterAsset(asset, projectId);
				const updated = await tx.project.update({
					where: { id: projectId },
					data: { posterAssetId: assetId },
				});
				await tx.project.update({ where: { id: projectId }, data: { version: { increment: 1 } } });
				if (before.publicationStatus === 'PUBLIC') assertPublicationNotWorsened(before, await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: publicationSnapshotInclude }));
				return updated;
			});
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
						currentWebglDeploymentId: true,
						webglDeployments: { select: webglDeletionSnapshotSelect },
					},
				});
				for (const project of projects) await cleanupSourceChangeRequests(tx, project.id);
				const canonicalActiveUploads = await tx.assetUploadSession.findMany({
					where: {
						projectId: { in: ids },
						state: { in: [...canonicalActiveUploadStates] },
					},
					select: { id: true, projectId: true, kind: true, objectKey: true, uploadId: true },
				});
				const activeUploads = canonicalActiveUploads.map(canonicalUploadCleanup);
				const assets = await tx.asset.findMany({
					where: { projectId: { in: ids } },
					include: { representations: true },
				});
				await queueDurableDeletions(tx, [
					...projectAssetDeletionTargets(assets, outbox),
					...projects.flatMap((project) => projectWebglDeletionTargets(
						project.id,
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
					if (!upload.objectKey || !upload.uploadId) continue;
					await queueMultipartAbortTask(tx, {
						bucket: outbox.protectedBucket,
						storageKey: upload.objectKey,
						uploadId: upload.uploadId,
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
   return client.$transaction(async (tx) => {
    for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
     await guardMutation(tx, undefined, id);
     const project = await tx.project.findUniqueOrThrow({ where: { id }, include: publicationSnapshotInclude });
     if (status === 'PUBLISHED') {
      assertPublication(project, 'OPERATOR');
      const submission = await tx.projectSubmission.findUnique({ where: { projectId: id } });
      if (submission && submission.state !== 'PUBLISHED') throw conflict('파일 처리 완료 후 개별 작품에서 공개하세요.');
     }
     await tx.project.update({ where: { id }, data: { publicationStatus: status === 'PUBLISHED' ? 'PUBLIC' : 'PRIVATE', legacyPublication: false, publicationRequested: false, version: { increment: 1 } } });
    }
    return { count: new Set(ids).size };
   });
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
				await tx.$queryRaw`SELECT id FROM exhibitions WHERE id = ${data.exhibitionId} FOR UPDATE`;
				const exhibition = await tx.exhibition.findUnique({ where: { id: data.exhibitionId } });
				if (!exhibition) throw notFound('Exhibition not found');
				if (data.actor && (!canReadVisibility(data.actor, exhibition.visibility)
					|| (!exhibition.isModificationEnabled && !isVisibilityStaff(data.actor)))) throw forbidden('Exhibition is not open for this submission');
    if (!data.allowDuplicateTitle) {
     const existing = await tx.project.findFirst({ where: { exhibitionId: data.exhibitionId, creatorId: data.creatorId, title: data.title, hiddenCancelled: false, changeRequestDraft: null }, orderBy: { id: 'asc' } });
     if (existing) throw new AppError(409, '같은 제목의 작품이 있습니다. 기존 작품을 이어서 수정하세요.', 'CONFLICT', { projectId: existing.id, publicationStatus: existing.publicationStatus });
    }
				const project = await tx.project.create({
					data: {
						exhibitionId: data.exhibitionId,
						visibility: data.visibility ?? 'PUBLIC',
						slug: data.slug,
						title: data.title,
						summary: data.summary,
						description: data.description,
						platforms: data.platforms,
						hardwareRequirements: data.hardwareRequirements,
						...(data.externalLinks !== undefined ? { externalLinks: data.externalLinks } : {}),
						status: 'DRAFT',
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
				const submission = await tx.projectSubmission.create({
					data: {
						projectId: project.id,
						actorId: data.creatorId,
						items: { create: data.manifest },
					},
					include: projectSubmissionInclude,
				});

				if (data.idempotency) {
					await succeedIdempotencyOperation(tx, {
						operationId: data.idempotency.operationId,
						ownerToken: data.idempotency.ownerToken,
						result: data.idempotency.resultForProject({ ...project, submission }),
					});
				}
				return { ...project, submission };
			});
		},
		async findSubmissionForActor(projectId, actor) {
			const submission = await client.projectSubmission.findUnique({
				where: { projectId },
				include: projectSubmissionInclude,
			});
			if (!submission) return null;
			await assertSubmissionActor(submission, actor);
			return submission;
		},
		finalizeSubmission(projectId, actor) {
			return withSerializableRetry(client, async (tx) => {
				await tx.$queryRaw(PrismaRuntime.sql`
					SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE
				`);
				await tx.$queryRaw(PrismaRuntime.sql`
					SELECT "id" FROM "project_submissions" WHERE "project_id" = ${projectId} FOR UPDATE
				`);
				const submission = await tx.projectSubmission.findUnique({
					where: { projectId },
					include: projectSubmissionInclude,
				});
				if (!submission) throw notFound('Project submission not found');
				await assertSubmissionActor(submission, actor, tx);
				if (submission.state === 'PUBLISHED') return submission;
				if (submission.state === 'FINALIZING') {
     if (submission.publicationJob?.state !== 'FAILED') return submission;
     await tx.projectSubmission.update({ where: { id: submission.id }, data: { state: 'PENDING' } });
     submission.state = 'PENDING';
    }
    if (submission.publicationJob && ['FAILED', 'CANCELLED'].includes(submission.publicationJob.state)) await tx.projectPublicationJob.delete({ where: { submissionId: submission.id } });
				if (submission.state !== 'PENDING') {
					throw conflict('Project submission cannot be finalized');
				}
    await guardMutation(tx, actor as Actor, projectId);
    const publicationSource = await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: publicationSnapshotInclude });
    const exception = publicationSource.publicationRequested ? publicationSource.publicationExceptionReason ?? undefined : undefined;
    assertPublication(publicationSource, actor.role, exception);
    const abandoned = await tx.projectSubmissionItem.findMany({ where: { submissionId: submission.id, state: { in: ['EXPECTED', 'FAILED', 'CANCELLED'] }, OR: [{ uploadSession: null }, { uploadSession: { state: { in: ['REJECTED', 'CANCELLED', 'EXPIRED'] } } }] }, select: { id: true } });
    const abandonedIds = abandoned.map(item => item.id);
    if (abandonedIds.length) {
     for (const id of abandonedIds) await tx.projectSubmissionItem.update({ where: { id }, data: { required: false, slot: `history:${id}` } });
     submission.items = submission.items.filter(item => !abandonedIds.includes(item.id));
    }

    await tx.project.update({ where: { id: projectId }, data: { publicationRequested: true, publicationRequestedVersion: publicationSource.version, publicationActorId: actor.id } });
				const invalid = await tx.$queryRaw<Array<{ count: bigint }>>(PrismaRuntime.sql`
					SELECT count(*)::bigint AS "count"
					FROM "project_submission_items" item
					LEFT JOIN "asset_upload_sessions" session ON session."submission_item_id" = item."id"
					LEFT JOIN "assets" asset ON asset."id" = item."result_asset_id"
					LEFT JOIN "asset_representations" representation ON representation."id" = item."result_representation_id"
					LEFT JOIN "webgl_deployments" deployment ON deployment."id" = item."result_webgl_deployment_id"
					LEFT JOIN "projects" project ON project."id" = ${projectId}
					WHERE item."submission_id" = ${submission.id} AND item."required" = true
					  AND (
						item."state" <> 'READY'::"ProjectSubmissionItemState"
						OR session."state" <> 'READY'::"AssetUploadSessionState"
						OR session."generation" IS DISTINCT FROM item."bound_generation"
						OR session."result_asset_id" IS DISTINCT FROM item."result_asset_id"
						OR session."result_representation_id" IS DISTINCT FROM item."result_representation_id"
						OR asset."project_id" IS DISTINCT FROM ${projectId}
						OR asset."kind"::text IS DISTINCT FROM item."kind"::text
						OR asset."status" <> 'READY'::"AssetStatus"
						OR representation."asset_id" IS DISTINCT FROM asset."id"
						OR representation."state" <> 'READY'::"AssetRepresentationState"
						OR (item."kind" = 'WEBGL'::"AssetUploadKind" AND (
							deployment."project_id" IS DISTINCT FROM ${projectId}
						OR deployment."source_representation_id" IS DISTINCT FROM representation."id"
							OR deployment."state" <> 'READY'::"WebglDeploymentState"
							OR NOT (
								(deployment."staging_bucket" IS NOT NULL AND deployment."staging_object_manifest" IS NOT NULL)
								OR project."current_webgl_deployment_id" IS NOT DISTINCT FROM deployment."id"
							)
						))
					  )
				`);
				if ((invalid[0]?.count ?? 0n) !== 0n) {
					throw conflict('Every selected project file must be READY before publication');
				}
				const imageAssetIds = submission.items
					.filter(({ kind }) => kind === 'IMAGE' || kind === 'POSTER')
					.map(({ resultAssetId }) => resultAssetId)
					.filter((id): id is number => id !== null);
				const representations = imageAssetIds.length === 0 ? [] : await tx.assetRepresentation.findMany({
					where: { assetId: { in: imageAssetIds }, role: { in: ['ORIGINAL', 'CARD_480', 'DISPLAY_960'] }, state: 'READY' },
				});
				if (representations.length !== imageAssetIds.length * 3) {
					throw conflict('Every DRAFT image representation must be staged before publication');
				}
				const imageFences = new Map(submission.items
					.filter((item) => (item.kind === 'IMAGE' || item.kind === 'POSTER')
						&& item.resultAssetId !== null && item.uploadSession !== null)
					.map((item) => [item.resultAssetId!, item.uploadSession!] as const));
				if (imageFences.size !== imageAssetIds.length) {
					throw conflict('Every DRAFT image representation must retain its upload source fence');
				}
				const publicationRepresentations = representations.map((representation) => {
					const fence = imageFences.get(representation.assetId);
					if (!fence) throw conflict('DRAFT image representation lost its submission item fence');
					if (!['ORIGINAL', 'CARD_480', 'DISPLAY_960'].includes(representation.role)) {
						throw conflict('DRAFT image representation has an invalid publication role');
					}
					return {
						...representation,
						role: representation.role as 'ORIGINAL' | 'CARD_480' | 'DISPLAY_960',
						generation: fence.generation,
						sourceIdentityAlgorithm: fence.sourceIdentityAlgorithm,
						sourceIdentity: fence.sourceIdentity,
					};
				});
				const deploymentIds = submission.items
					.map(({ resultWebglDeploymentId }) => resultWebglDeploymentId)
					.filter((id): id is string => id !== null);
				const deployments = deploymentIds.length === 0 ? [] : await tx.webglDeployment.findMany({
					where: { id: { in: deploymentIds }, projectId, state: 'READY' },
				});
				if (deployments.length !== deploymentIds.length) {
					throw conflict('Every DRAFT WebGL deployment must be staged before publication');
				}
				let plan;
				try {
					plan = createProjectPublicationPlan({
						projectId,
						submissionId: submission.id,
						protectedBucket: buckets.protectedBucket,
						publicBucket: buckets.publicBucket,
						representations: publicationRepresentations,
						webglDeployments: deployments,
					});
				} catch (error) {
					throw conflict(error instanceof Error ? error.message : 'Publication plan is malformed');
				}
				await tx.projectPublicationJob.create({
					data: {
						projectId,
						submissionId: submission.id,
						plan: plan as unknown as Prisma.InputJsonValue,
					},
				});
				const finalizing = await tx.projectSubmission.updateMany({
					where: { id: submission.id, state: 'PENDING' },
					data: { state: 'FINALIZING' },
				});
				if (finalizing.count !== 1) throw conflict('Project submission changed concurrently');
				return tx.projectSubmission.findUniqueOrThrow({
					where: { id: submission.id },
					include: projectSubmissionInclude,
				});
			});
		},
		cancelSubmission(projectId, actor) {
			return withSerializableRetry(client, async (tx) => {
				await tx.$queryRaw(PrismaRuntime.sql`
					SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE
				`);
				await tx.$queryRaw(PrismaRuntime.sql`
					SELECT "id" FROM "project_submissions" WHERE "project_id" = ${projectId} FOR UPDATE
				`);
				const submission = await tx.projectSubmission.findUnique({
					where: { projectId },
					include: projectSubmissionInclude,
				});
				if (!submission) throw notFound('Project submission not found');
				await assertSubmissionActor(submission, actor, tx);
				if (submission.state === 'CANCELLED') return submission;
				if (!['PENDING', 'FINALIZING'].includes(submission.state)) {
					throw conflict('Published project submission cannot be cancelled');
				}
    await guardMutation(tx, actor as Actor, projectId);
    const sessions = await tx.assetUploadSession.findMany({ where: { projectId, state: { in: [...canonicalActiveUploadStates] } } });
    for (const session of sessions) {
     if (session.uploadId) await queueMultipartAbortTask(tx, { bucket: session.bucket, storageKey: session.objectKey, uploadId: session.uploadId, reason: 'project-upload-stopped', uploadSessionId: session.id });
     await queueDurableDeletions(tx, [{ bucket: session.bucket, storageKey: session.objectKey, reason: 'project-upload-stopped' }]);
    }
    await tx.assetUploadSession.updateMany({ where: { id: { in: sessions.map(s => s.id) } }, data: { state: 'CANCELLED', uploadId: null, completionLeaseToken: null, completionLeaseUntil: null, validationLeaseToken: null, validationLeaseUntil: null } });
    await tx.projectSubmissionItem.updateMany({ where: { submissionId: submission.id, state: { not: 'READY' } }, data: { state: 'CANCELLED', failureReason: '업로드를 중단했습니다. 필요한 파일을 다시 선택하세요.' } });
    await tx.project.update({ where: { id: projectId }, data: { publicationRequested: false, publicationStatus: 'PRIVATE', version: { increment: 1 } } });
    if (submission.publicationJob) await tx.projectPublicationJob.update({ where: { submissionId: submission.id }, data: { state: 'CANCELLED', claimToken: null, claimUntil: null } });
    await tx.projectSubmission.update({ where: { id: submission.id }, data: { state: 'PENDING' } });

				return tx.projectSubmission.findUniqueOrThrow({
					where: { id: submission.id },
					include: projectSubmissionInclude,
				});
				});
		},
		async auditActiveSubmissions() {
			const [draftProjects, pendingSubmissions, finalizingSubmissions, activePublicationJobs] = await client.$transaction([
				client.project.count({ where: { status: 'DRAFT' } }),
				client.projectSubmission.count({ where: { state: 'PENDING' } }),
				client.projectSubmission.count({ where: { state: 'FINALIZING' } }),
				client.projectPublicationJob.count({ where: { state: { in: ['PENDING', 'PROCESSING'] } } }),
			]);
			return { draftProjects, pendingSubmissions, finalizingSubmissions, activePublicationJobs };
		},
	};
}
