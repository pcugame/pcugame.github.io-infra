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
		include: { exhibition: true, creator: true },
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

// ── Transactional project creation (submit) ─────────────────

export interface SubmitProjectData {
	exhibitionId: number;
	slug: string;
	title: string;
	summary?: string;
	description?: string;
	videoUrl?: string;
	videoMimeType?: string;
	status: ProjectStatus;
	creatorId: number;
	creatorName: string;
	members: { name: string; studentId: string; sortOrder?: number }[];
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
				videoUrl: data.videoUrl,
				videoMimeType: data.videoMimeType,
				status: data.status,
				creatorId: data.creatorId,
				members: {
					create: data.members.map((m, i) => ({
						name: m.name,
						studentId: m.studentId,
						sortOrder: m.sortOrder ?? i,
						...(m.name === data.creatorName ? { userId: data.creatorId } : {}),
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
