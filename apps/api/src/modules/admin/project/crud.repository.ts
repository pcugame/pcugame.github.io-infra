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
import { conflict, forbidden, notFound } from '../../../shared/errors.js';
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
const projectListInclude = {
	exhibition: true,
	creator: true,
	members: { orderBy: { sortOrder: 'asc' as const }, select: { name: true, studentId: true, userId: true } },
	assets: {
		where: { status: 'READY' as const, kind: { in: projectListPlayableKinds } },
		select: { kind: true },
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
	exhibition: true,
	changeRequestDraft: { select: { id: true } },
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: {
		where: { status: 'READY' as const },
		orderBy: { createdAt: 'asc' as const },
		include: { representations: true },
	},
	poster: { include: { representations: { where: { state: 'READY' as const } } } },
	currentWebglDeployment: true,
} as const;

const projectSubmissionInclude = {
	project: { select: { id: true, status: true } },
	publicationJob: { select: { state: true, lastError: true } },
	items: {
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

function buildProjectListWhere(
	userId: number,
	isPrivileged: boolean,
	options: FindProjectsForUserOptions,
): Prisma.ProjectWhereInput {
	const and: Prisma.ProjectWhereInput[] = [{ changeRequestDraft: null }];
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

	function assertSubmissionActor(
		submission: { actorId: number },
		actor: { id: number; role: string },
	): void {
		if (actor.role !== 'ADMIN' && actor.role !== 'OPERATOR' && submission.actorId !== actor.id) {
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
				const current = await tx.project.findUniqueOrThrow({ where: { id }, select: { status: true } });
				if (current.status === 'DRAFT' && data.status !== undefined && data.status !== 'DRAFT') {
					throw conflict('Draft submissions may only be published by submission finalize');
				}
				await tx.project.update({ where: { id }, data });
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
				const draftCount = await tx.project.count({ where: { id: { in: ids }, status: 'DRAFT' } });
				if (draftCount > 0 && status !== 'DRAFT') {
					throw conflict('Draft submissions may only be published by submission finalize');
				}
				return tx.project.updateMany({ where: { id: { in: ids } }, data: { status } });
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
				const project = await tx.project.create({
					data: {
						exhibitionId: data.exhibitionId,
						slug: data.slug,
						title: data.title,
						summary: data.summary,
						description: data.description,
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
			assertSubmissionActor(submission, actor);
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
				assertSubmissionActor(submission, actor);
				if (submission.state === 'PUBLISHED' && submission.project.status === 'PUBLISHED') return submission;
				if (submission.state === 'FINALIZING' && submission.project.status === 'DRAFT') return submission;
				if (submission.state !== 'PENDING' || submission.project.status !== 'DRAFT') {
					throw conflict('Project submission cannot be finalized');
				}
				const invalid = await tx.$queryRaw<Array<{ count: bigint }>>(PrismaRuntime.sql`
					SELECT count(*)::bigint AS "count"
					FROM "project_submission_items" item
					LEFT JOIN "asset_upload_sessions" session ON session."submission_item_id" = item."id"
					LEFT JOIN "assets" asset ON asset."id" = item."result_asset_id"
					LEFT JOIN "asset_representations" representation ON representation."id" = item."result_representation_id"
					LEFT JOIN "webgl_deployments" deployment ON deployment."id" = item."result_webgl_deployment_id"
					LEFT JOIN "projects" project ON project."id" = ${projectId}
					WHERE item."submission_id" = ${submission.id}
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
				assertSubmissionActor(submission, actor);
				if (submission.state === 'CANCELLED') return submission;
				if (!['PENDING', 'FINALIZING'].includes(submission.state) || submission.project.status !== 'DRAFT') {
					throw conflict('Published project submission cannot be cancelled');
				}
				const [assets, deployments, sessions] = await Promise.all([
					tx.asset.findMany({ where: { projectId }, include: { representations: true } }),
					tx.webglDeployment.findMany({ where: { projectId }, select: webglDeletionSnapshotSelect }),
					tx.assetUploadSession.findMany({
						where: { submissionItem: { projectSubmission: { id: submission.id } } },
						select: { id: true, kind: true, bucket: true, objectKey: true, uploadId: true },
					}),
				]);
				await queueDurableDeletions(tx, [
					...deployments.filter((deployment) => deployment.stagingBucket && deployment.stagingPrefix).map((deployment) => ({
						bucket: deployment.stagingBucket!,
						storageKey: deployment.stagingPrefix!,
						targetKind: 'PREFIX' as const,
						reason: 'project-submission-cancelled-webgl-staging',
					})),
					...projectAssetDeletionTargets(assets, { ...buckets, reason: 'project-submission-cancelled' }),
					...projectWebglDeletionTargets(projectId, { ...buckets, reason: 'project-submission-cancelled' }, deployments),
					...sessions.map((session) => ({
						bucket: session.bucket,
						storageKey: session.objectKey,
						reason: 'project-submission-cancelled-source',
					})),
				]);
				for (const session of sessions) {
					if (!session.uploadId) continue;
					await queueMultipartAbortTask(tx, {
						bucket: session.bucket,
						storageKey: session.objectKey,
						uploadId: session.uploadId,
						reason: 'project-submission-cancelled-multipart',
						uploadSessionId: session.id,
					});
				}
				await tx.assetUploadSession.updateMany({
					where: { id: { in: sessions.map(({ id }) => id) } },
					data: {
						state: 'CANCELLED', uploadId: null,
						completionLeaseToken: null, completionLeaseUntil: null,
						validationLeaseToken: null, validationLeaseUntil: null,
					},
				});
				await tx.project.update({
					where: { id: projectId },
					data: { posterAssetId: null, currentWebglDeploymentId: null },
				});
				await tx.webglDeployment.deleteMany({ where: { projectId } });
				await tx.asset.deleteMany({ where: { projectId } });
				await tx.projectSubmissionItem.updateMany({
					where: { submissionId: submission.id },
					data: {
						state: 'CANCELLED', resultAssetId: null,
						resultRepresentationId: null, resultWebglDeploymentId: null,
						failureReason: 'submission cancelled',
						playbackState: 'NONE', playbackError: null,
					},
				});
				if (submission.publicationJob) await tx.projectPublicationJob.update({
					where: { submissionId: submission.id },
					data: { state: 'CANCELLED', claimToken: null, claimUntil: null },
				});
				await tx.projectSubmission.update({
					where: { id: submission.id },
					data: { state: 'CANCELLED', cancelledAt: new Date() },
				});
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
