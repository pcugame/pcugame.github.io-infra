import { prisma } from '../../../lib/prisma.js';
import type { AssetKind, AssetPlaybackStatus, ProjectStatus, Prisma } from '../../../generated/prisma/client.js';
import { Prisma as PrismaRuntime } from '../../../generated/prisma/client.js';

type TxClient = Prisma.TransactionClient;

const serializableOptions = {
	isolationLevel: PrismaRuntime.TransactionIsolationLevel.Serializable,
} as const;

function isRetryableTransactionError(err: unknown): boolean {
	return err instanceof PrismaRuntime.PrismaClientKnownRequestError
		&& (err.code === 'P2034' || err.code === 'P2002');
}

async function withSerializableRetry<T>(
	fn: (tx: TxClient) => Promise<T>,
	maxAttempts = 3,
): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await prisma.$transaction(fn, serializableOptions);
		} catch (err) {
			lastErr = err;
			if (!isRetryableTransactionError(err) || attempt === maxAttempts) {
				throw err;
			}
		}
	}
	throw lastErr;
}

// ── Shared include spec for project detail queries ──────────

export const projectDetailInclude = {
	exhibition: true,
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: { where: { status: 'READY' as const }, orderBy: { createdAt: 'asc' as const } },
	poster: true,
} as const;

// ── Project queries ─────────────────────────────────────────

const projectListPlayableKinds: AssetKind[] = ['GAME', 'VIDEO'];

const projectListInclude = {
	exhibition: true,
	creator: true,
	members: { orderBy: { sortOrder: 'asc' as const }, select: { name: true, studentId: true } },
	// Just enough to decide whether `isIncomplete` should be suppressed in the response.
	assets: {
		where: { status: 'READY' as const, kind: { in: projectListPlayableKinds } },
		select: { kind: true },
	},
	poster: { select: { kind: true, status: true, storageKey: true } },
} as const satisfies Prisma.ProjectInclude;

export type ProjectListSort = 'createdAt' | 'title' | 'year' | 'status';
export type SortOrder = 'asc' | 'desc';

export type FindProjectsForUserOptions = {
	page: number;
	limit: number;
	search?: string;
	year?: number;
	status?: ProjectStatus;
	sort: ProjectListSort;
	order: SortOrder;
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

	if (options.year !== undefined) {
		and.push({ exhibition: { year: options.year } });
	}

	if (options.status !== undefined) {
		and.push({ status: options.status });
	}

	return and.length > 0 ? { AND: and } : {};
}

function buildProjectListOrderBy(
	sort: ProjectListSort,
	order: SortOrder,
): Prisma.ProjectOrderByWithRelationInput[] {
	const primary: Prisma.ProjectOrderByWithRelationInput =
		sort === 'year'
			? { exhibition: { year: order } }
			: { [sort]: order };

	return [primary, { id: order }];
}

/** List projects visible to the given user (privileged sees all) */
export function findProjectsForUser(
	userId: number,
	isPrivileged: boolean,
	options: FindProjectsForUserOptions,
) {
	const where = buildProjectListWhere(userId, isPrivileged, options);
	const orderBy = buildProjectListOrderBy(options.sort, options.order);
	const skip = (options.page - 1) * options.limit;
	const take = options.limit;

	return prisma.$transaction([
		prisma.project.count({ where }),
		prisma.project.findMany({
			where,
			orderBy,
			skip,
			take,
			include: projectListInclude,
		}),
	]).then(([totalItems, items]) => ({ totalItems, items }));
}

/** Find a project by ID with full detail includes */
export function findProjectById(id: number) {
	return prisma.project.findUnique({
		where: { id },
		include: projectDetailInclude,
	});
}

/** Check if a user is a linked member of a project */
export function isMemberOfProject(projectId: number, userId: number) {
	return prisma.projectMember.findFirst({
		where: { projectId, userId },
	});
}

/** Partial-update a project and return with full detail */
export function updateProject(id: number, data: Prisma.ProjectUpdateInput) {
	return prisma.project.update({
		where: { id },
		data,
		include: projectDetailInclude,
	});
}

/** Delete a project by ID */
export function deleteProjectReturningAssets(id: number) {
	return prisma.$transaction(async (tx) => {
		const assets = await tx.asset.findMany({ where: { projectId: id } });
		await tx.project.update({
			where: { id },
			data: { posterAssetId: null },
			select: { id: true },
		});
		await tx.asset.deleteMany({ where: { projectId: id } });
		await tx.project.delete({ where: { id } });
		return assets;
	});
}

/** Find all assets for a project */
export function findAssetsByProjectId(projectId: number) {
	return prisma.asset.findMany({ where: { projectId } });
}

/** Check if a slug already exists within an exhibition */
export function findProjectByExhibitionAndSlug(exhibitionId: number, slug: string) {
	return prisma.project.findUnique({
		where: { project_exhibition_slug: { exhibitionId, slug } },
	});
}

/** Find an exhibition by ID */
export function findExhibitionById(id: number) {
	return prisma.exhibition.findUnique({ where: { id } });
}

// ── Asset queries ───────────────────────────────────────────

/** Find the first GAME asset in READY status for a project */
export function findReadyGameAsset(projectId: number) {
	return prisma.asset.findFirst({
		where: { projectId, kind: 'GAME', status: 'READY' },
		select: { id: true, storageKey: true },
	});
}

/** Find the first VIDEO asset in READY status for a project */
export function findReadyVideoAsset(projectId: number) {
	return prisma.asset.findFirst({
		where: { projectId, kind: 'VIDEO', status: 'READY' },
		select: { id: true, storageKey: true },
	});
}

/** Create a new asset */
export function createAsset(data: {
	projectId: number;
	kind: AssetKind;
	storageKey: string;
	playbackStorageKey?: string | null;
	originalName: string;
	mimeType: string;
	playbackMimeType?: string;
	sizeBytes: bigint;
	playbackSizeBytes?: bigint;
	playbackStatus?: AssetPlaybackStatus;
	playbackError?: string;
	isPublic: boolean;
}) {
	return prisma.asset.create({ data });
}

/** Replace an existing asset's file metadata */
export function updateAssetFile(
	id: number,
	data: {
		storageKey: string;
		playbackStorageKey?: string | null;
		originalName: string;
		mimeType: string;
		playbackMimeType?: string;
		sizeBytes: bigint;
		playbackSizeBytes?: bigint;
		playbackStatus?: AssetPlaybackStatus;
		playbackError?: string;
	},
) {
	return prisma.asset.update({ where: { id }, data });
}

/**
 * Replace the single READY asset of a given kind for a project, or create one if none exists.
 * Serialized with a Serializable Prisma transaction. The partial unique index for READY
 * GAME assets closes concurrent create races; serialization retries handle write conflicts.
 *
 * Returns `oldStorageKey` for callers that need to clean up the prior S3 object after commit.
 */
export function replaceOrCreateReplaceableAsset(
	projectId: number,
	kind: AssetKind,
	data: {
		storageKey: string;
		playbackStorageKey?: string | null;
		originalName: string;
		mimeType: string;
		playbackMimeType?: string;
		sizeBytes: bigint;
		playbackSizeBytes?: bigint;
		playbackStatus?: AssetPlaybackStatus;
		playbackError?: string;
		isPublic: boolean;
	},
): Promise<{ assetId: number; oldStorageKey: string | null; oldPlaybackStorageKey: string | null }> {
	return withSerializableRetry(async (tx) => {
		const existing = await tx.asset.findFirst({
			where: { projectId, kind, status: 'READY' },
			select: { id: true, storageKey: true, playbackStorageKey: true },
		});

		if (existing) {
			const updated = await tx.asset.update({
				where: { id: existing.id },
				data: {
					storageKey: data.storageKey,
					playbackStorageKey: data.playbackStorageKey ?? null,
					originalName: data.originalName,
					mimeType: data.mimeType,
					playbackMimeType: data.playbackMimeType ?? '',
					sizeBytes: data.sizeBytes,
					playbackSizeBytes: data.playbackSizeBytes ?? BigInt(0),
					playbackStatus: data.playbackStatus ?? 'PENDING',
					playbackError: data.playbackError ?? '',
				},
				select: { id: true },
			});
			return {
				assetId: updated.id,
				oldStorageKey: existing.storageKey,
				oldPlaybackStorageKey: existing.playbackStorageKey,
			};
		}

		const created = await tx.asset.create({
			data: {
				projectId,
				kind,
				storageKey: data.storageKey,
				playbackStorageKey: data.playbackStorageKey ?? null,
				originalName: data.originalName,
				mimeType: data.mimeType,
				playbackMimeType: data.playbackMimeType ?? '',
				sizeBytes: data.sizeBytes,
				playbackSizeBytes: data.playbackSizeBytes ?? BigInt(0),
				playbackStatus: data.playbackStatus ?? 'PENDING',
				playbackError: data.playbackError ?? '',
				isPublic: data.isPublic,
			},
			select: { id: true },
		});
		return { assetId: created.id, oldStorageKey: null, oldPlaybackStorageKey: null };
	});
}

/** Find a single asset by ID */
export function findAssetById(id: number) {
	return prisma.asset.findUnique({ where: { id } });
}

/** Set a project's poster asset ID */
export function setProjectPoster(projectId: number, assetId: number) {
	return prisma.project.update({
		where: { id: projectId },
		data: { posterAssetId: assetId },
	});
}

// ── Bulk operations ────────────────────────────────────────

/** Update status on multiple projects */
export function bulkUpdateStatus(ids: number[], status: ProjectStatus) {
	return prisma.project.updateMany({
		where: { id: { in: ids } },
		data: { status },
	});
}

/** Find all assets belonging to multiple projects */
export function findAssetsByProjectIds(projectIds: number[]) {
	return prisma.asset.findMany({
		where: { projectId: { in: projectIds } },
	});
}

/** Delete multiple projects (cascades members; assets must be deleted first) */
export async function bulkDeleteProjectsReturningAssets(ids: number[]) {
	// All three steps share a transaction so a partial failure can't leave the rows in the
	// half-broken state where posterAssetId is nulled but the asset rows still point at a
	// project that has been deleted (or worse, vice-versa).
	return prisma.$transaction(async (tx) => {
		const assets = await tx.asset.findMany({ where: { projectId: { in: ids } } });
		await tx.project.updateMany({
			where: { id: { in: ids } },
			data: { posterAssetId: null },
		});
		await tx.asset.deleteMany({ where: { projectId: { in: ids } } });
		const result = await tx.project.deleteMany({ where: { id: { in: ids } } });
		return { result, assets };
	});
}

// ── Transactional project creation (submit) ─────────────────

export interface SubmitProjectData {
	exhibitionId: number;
	slug: string;
	title: string;
	summary?: string;
	description?: string;
	status: ProjectStatus;
	creatorId: number;
	members: { name: string; studentId: string; sortOrder?: number; userId?: number }[];
	savedFiles: {
		kind: AssetKind;
		storageKey: string;
		playbackStorageKey?: string | null;
		originalName: string;
		mimeType: string;
		playbackMimeType?: string;
		sizeBytes: number;
		playbackSizeBytes?: number;
		playbackStatus?: AssetPlaybackStatus;
		playbackError?: string;
	}[];
}

/**
 * Create a project with members and assets in a single transaction.
 * Returns the created project record.
 */
export function createProjectWithAssets(data: SubmitProjectData) {
	return prisma.$transaction(async (tx) => {
		const p = await tx.project.create({
			data: {
				exhibitionId: data.exhibitionId,
				slug: data.slug,
				title: data.title,
				summary: data.summary,
				description: data.description,
				status: data.status,
				creatorId: data.creatorId,
				members: {
					create: data.members.map((m, i) => ({
						name: m.name,
						studentId: m.studentId,
						sortOrder: m.sortOrder ?? i,
						...(m.userId ? { userId: m.userId } : {}),
					})),
				},
			},
		});

		let posterAssetId: number | null = null;
		for (const sf of data.savedFiles) {
			const asset = await tx.asset.create({
				data: {
					projectId: p.id,
					kind: sf.kind,
					storageKey: sf.storageKey,
					playbackStorageKey: sf.playbackStorageKey ?? null,
					originalName: sf.originalName,
					mimeType: sf.mimeType,
					playbackMimeType: sf.playbackMimeType ?? '',
					sizeBytes: BigInt(sf.sizeBytes),
					playbackSizeBytes: BigInt(sf.playbackSizeBytes ?? 0),
					playbackStatus: sf.playbackStatus ?? 'PENDING',
					playbackError: sf.playbackError ?? '',
					isPublic: sf.kind !== 'GAME' && sf.kind !== 'VIDEO',
				},
			});
			if (sf.kind === 'POSTER' && !posterAssetId) posterAssetId = asset.id;
		}

		if (posterAssetId) {
			await tx.project.update({ where: { id: p.id }, data: { posterAssetId } });
		}

		return p;
	});
}
