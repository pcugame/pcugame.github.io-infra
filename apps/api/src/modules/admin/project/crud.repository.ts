import type {
	AssetKind,
	Prisma,
	PrismaClient,
	ProjectStatus,
} from '../../../generated/prisma/client.js';
import { Prisma as PrismaRuntime } from '../../../generated/prisma/client.js';
import { notFound } from '../../../shared/errors.js';
import { assertValidPosterAsset } from '../../../shared/poster-validation.js';
import {
	ASSET_MUTATION_TRANSACTION_POLICY,
	withAssetMutationTransaction,
} from '../../assets/mutation-transaction.js';
import { queueDurableDeletions, type DurableDeletionTarget } from '../../orphan/outbox.js';
import {
	webglDeletionTargetsByEntry,
	webglDeletionTargetsBySource,
} from '../../webgl/deletion-targets.js';
import type {
	DeletionOutboxConfig,
	ProjectCrudRepository,
} from './ports.js';

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
	poster: { select: { kind: true, status: true, storageKey: true } },
} as const satisfies Prisma.ProjectInclude;

export const projectDetailInclude = {
	exhibition: true,
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: { where: { status: 'READY' as const }, orderBy: { createdAt: 'asc' as const } },
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

function assetBucket(kind: AssetKind, config: DeletionOutboxConfig): string {
	return kind === 'GAME' || kind === 'VIDEO' ? config.protectedBucket : config.publicBucket;
}

function assetDeletionTargets(
	assets: Array<{ kind: AssetKind; storageKey: string; playbackStorageKey: string | null }>,
	config: DeletionOutboxConfig,
): DurableDeletionTarget[] {
	return assets.flatMap((asset) => {
		const bucket = assetBucket(asset.kind, config);
		return [
			{ bucket, storageKey: asset.storageKey, reason: config.reason },
			...(asset.playbackStorageKey && asset.playbackStorageKey !== asset.storageKey
				? [{ bucket, storageKey: asset.playbackStorageKey, reason: `${config.reason}-playback` }]
				: []),
		];
	});
}

function activeUploadDeletionTargets(
	projectId: number,
	uploads: Array<{ uploadKind: string; s3Key: string | null }>,
	config: DeletionOutboxConfig,
): DurableDeletionTarget[] {
	return uploads.flatMap((upload) => {
		if (!upload.s3Key) return [];
		if (upload.uploadKind === 'WEBGL') {
			return webglDeletionTargetsBySource(projectId, upload.s3Key, config, `${config.reason}-active-upload`);
		}
		return [{
			bucket: config.protectedBucket,
			storageKey: upload.s3Key,
			reason: `${config.reason}-active-upload`,
		}];
	});
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
} {
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
				const assets = await tx.asset.findMany({ where: { projectId: id } });
				await queueDurableDeletions(tx, [
					...assetDeletionTargets(assets, outbox),
					...webglDeletionTargetsByEntry(id, project.webglEntryKey, outbox, outbox.reason),
					...activeUploadDeletionTargets(id, activeUploads, outbox),
				]);
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
					...webglDeletionTargetsByEntry(projectId, project.webglEntryKey, outbox, outbox.reason),
					...activeUploadDeletionTargets(projectId, active?.session ? [active.session] : [], outbox),
				]);
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
			return withAssetMutationTransaction(client, async (tx) => {
				const projects = await tx.$queryRaw<Array<{ id: number }>>(PrismaRuntime.sql`
					SELECT "id" FROM "projects" WHERE "id" = ${projectId} FOR UPDATE
				`);
				if (projects.length === 0) throw notFound('Project not found');
				const assets = await tx.$queryRaw<Array<{
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
				assertValidPosterAsset(assets[0] ?? null, projectId);
				return tx.project.update({
					where: { id: projectId },
					data: { posterAssetId: assetId },
				});
			}, ASSET_MUTATION_TRANSACTION_POLICY);
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
				const assets = await tx.asset.findMany({ where: { projectId: { in: ids } } });
				await queueDurableDeletions(tx, [
					...assetDeletionTargets(assets, outbox),
					...projects.flatMap((project) => webglDeletionTargetsByEntry(
						project.id,
						project.webglEntryKey,
						outbox,
						outbox.reason,
					)),
					...projects.flatMap((project) => activeUploadDeletionTargets(
						project.id,
						activeUploads.filter((upload) => upload.projectId === project.id),
						outbox,
					)),
				]);
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
	};
}
