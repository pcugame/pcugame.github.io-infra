import { prisma } from '../../../lib/prisma.js';
import type { AssetKind, ProjectStatus, Prisma } from '@prisma/client';

// ── Shared include spec for project detail queries ──────────

export const projectDetailInclude = {
	exhibition: true,
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: { where: { status: 'READY' as const }, orderBy: { createdAt: 'asc' as const } },
	poster: true,
} as const;

// ── Project queries ─────────────────────────────────────────

/** List projects visible to the given user (privileged sees all) */
export function findProjectsForUser(userId: number, isPrivileged: boolean) {
	return prisma.project.findMany({
		where: isPrivileged
			? {}
			: {
					OR: [
						{ creatorId: userId },
						{ members: { some: { userId } } },
					],
				},
		orderBy: { createdAt: 'desc' },
		include: {
			exhibition: true,
			creator: true,
			members: { orderBy: { sortOrder: 'asc' as const }, select: { name: true } },
			// Just enough to decide whether `isIncomplete` should be suppressed in the response.
			assets: {
				where: { status: 'READY', kind: { in: ['GAME', 'VIDEO'] } },
				select: { kind: true },
			},
			poster: { select: { kind: true, status: true, storageKey: true } },
		},
	});
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
export function deleteProject(id: number) {
	return prisma.project.delete({ where: { id } });
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
	originalName: string;
	mimeType: string;
	sizeBytes: bigint;
	isPublic: boolean;
}) {
	return prisma.asset.create({ data });
}

/** Replace an existing asset's file metadata */
export function updateAssetFile(
	id: number,
	data: { storageKey: string; originalName: string; mimeType: string; sizeBytes: bigint },
) {
	return prisma.asset.update({ where: { id }, data });
}

/**
 * Replace the single READY asset of a given kind for a project, or create one if none exists.
 * Serialized per-project by taking SELECT ... FOR UPDATE on the parent project row — this
 * closes the "two concurrent inserts see no existing asset and both create one" race that
 * leaves a stray asset + orphaned S3 object.
 *
 * Returns `oldStorageKey` for callers that need to clean up the prior S3 object after commit.
 */
export function replaceOrCreateReplaceableAsset(
	projectId: number,
	kind: AssetKind,
	data: {
		storageKey: string;
		originalName: string;
		mimeType: string;
		sizeBytes: bigint;
		isPublic: boolean;
	},
): Promise<{ assetId: number; oldStorageKey: string | null }> {
	return prisma.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;

		const existing = await tx.asset.findFirst({
			where: { projectId, kind, status: 'READY' },
			select: { id: true, storageKey: true },
		});

		if (existing) {
			const updated = await tx.asset.update({
				where: { id: existing.id },
				data: {
					storageKey: data.storageKey,
					originalName: data.originalName,
					mimeType: data.mimeType,
					sizeBytes: data.sizeBytes,
				},
				select: { id: true },
			});
			return { assetId: updated.id, oldStorageKey: existing.storageKey };
		}

		const created = await tx.asset.create({
			data: {
				projectId,
				kind,
				storageKey: data.storageKey,
				originalName: data.originalName,
				mimeType: data.mimeType,
				sizeBytes: data.sizeBytes,
				isPublic: data.isPublic,
			},
			select: { id: true },
		});
		return { assetId: created.id, oldStorageKey: null };
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
export async function bulkDeleteProjects(ids: number[]) {
	// All three steps share a transaction so a partial failure can't leave the rows in the
	// half-broken state where posterAssetId is nulled but the asset rows still point at a
	// project that has been deleted (or worse, vice-versa).
	return prisma.$transaction(async (tx) => {
		await tx.project.updateMany({
			where: { id: { in: ids } },
			data: { posterAssetId: null },
		});
		await tx.asset.deleteMany({ where: { projectId: { in: ids } } });
		return tx.project.deleteMany({ where: { id: { in: ids } } });
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
	savedFiles: { kind: AssetKind; storageKey: string; originalName: string; mimeType: string; sizeBytes: number }[];
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
					originalName: sf.originalName,
					mimeType: sf.mimeType,
					sizeBytes: BigInt(sf.sizeBytes),
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
