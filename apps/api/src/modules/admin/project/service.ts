import type { ProjectStatus } from '../../../generated/prisma/client.js';
import type { AdminProjectItem, AdminProjectListQuery, AdminProjectListResponse } from '@pcu/contracts';
import { forbidden, notFound } from '../../../shared/errors.js';
import { assertValidPosterAsset } from '../../../shared/poster-validation.js';
import { effectiveIsIncomplete } from '../../../shared/project-completeness.js';
import { assetUrl, serializeProjectDetail } from './serializer.js';
import { deleteAssetObjects } from './asset-cleanup.js';
import { env } from '../../../config/env.js';
import { abortMultipartUpload } from '../../../lib/storage.js';
import { logger } from '../../../lib/logger.js';
import { cleanupWebglDeployment, cleanupWebglEntry } from '../../webgl/deployment.js';
import { parseWebglSourceKey } from '../../webgl/paths.js';
import * as repo from './repository.js';

export { assetUrl, serializeProjectDetail } from './serializer.js';
export { assertStatusTransition, bulkUpdateStatus } from './project-status.service.js';
export { submitProject, processFileParts } from './project-submit.service.js';
export type { SubmitProjectAudience, SubmitProjectOptions } from './project-submit.service.js';
export { addAssetToProject, isReplaceableAssetKind } from './project-asset.service.js';
export { collectMultipartParts } from '../../assets/upload/multipart-collector.js';
export type { CollectedFilePart } from '../../assets/upload/multipart-collector.js';

// ── Business logic ──────────────────────────────────────────

/** List projects visible to the current user */
export async function listProjects(
	userId: number,
	userRole: string,
	options: AdminProjectListQuery = {},
): Promise<AdminProjectListResponse> {
	const listOptions: repo.FindProjectsForUserOptions = {
		page: options.page ?? 1,
		limit: options.limit ?? 20,
		search: options.search,
		year: options.year,
		status: options.status,
		sort: options.sort ?? 'createdAt',
		order: options.order ?? 'desc',
	};
	const isPrivileged = userRole === 'ADMIN' || userRole === 'OPERATOR';
	const { items: projects, totalItems } = await repo.findProjectsForUser(userId, isPrivileged, listOptions);
	const totalPages = Math.ceil(totalItems / listOptions.limit);
	const items: AdminProjectItem[] = projects.map((p) => ({
		id: p.id,
		title: p.title,
		slug: p.slug,
		year: p.exhibition.year,
		isIncomplete: effectiveIsIncomplete(p.isIncomplete, p.assets, p.poster),
		status: p.status,
		createdByUserName: p.creator.name || undefined,
		memberNames: p.members.map((m) => m.name),
		memberStudentIds: p.members.map((m) => m.studentId),
		updatedAt: p.updatedAt.toISOString(),
	}));

	return {
		items,
		pagination: {
			page: listOptions.page,
			limit: listOptions.limit,
			totalItems,
			totalPages,
			hasNextPage: listOptions.page < totalPages,
			hasPreviousPage: listOptions.page > 1 && totalItems > 0,
		},
	};
}

/** Get a single project detail with access check for read */
export async function getProjectDetail(projectId: number, userId: number, userRole: string) {
	const project = await repo.findProjectById(projectId);
	if (!project) throw notFound('Project not found');

	if (userRole !== 'ADMIN' && userRole !== 'OPERATOR' && project.creatorId !== userId) {
		const isMember = !!(await repo.isMemberOfProject(project.id, userId));
		if (!isMember) throw forbidden('Not your project');
	}

	return serializeProjectDetail(project);
}

/** Partial-update a project */
export async function updateProject(
	projectId: number,
	patch: {
		title?: string; summary?: string; description?: string;
		isIncomplete?: boolean; status?: ProjectStatus; sortOrder?: number;
	},
) {
	const updated = await repo.updateProject(projectId, {
		...(patch.title !== undefined ? { title: patch.title } : {}),
		...(patch.summary !== undefined ? { summary: patch.summary } : {}),
		...(patch.description !== undefined ? { description: patch.description } : {}),
		...(patch.isIncomplete !== undefined ? { isIncomplete: patch.isIncomplete } : {}),
		...(patch.status !== undefined ? { status: patch.status } : {}),
		...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
	});

	return serializeProjectDetail(updated);
}

/** Delete a project and its associated asset files from S3 */
export async function deleteProject(projectId: number) {
	const { assets, webglEntryKey, activeUploads } = await repo.deleteProjectReturningAssets(projectId);
	await Promise.all(
		assets.map((asset) => deleteAssetObjects({ ...asset, projectId }, 'project-delete')),
	);
	await cleanupDeletedProjectWebgl(projectId, webglEntryKey, activeUploads, 'project-delete');
}

type ActiveUploadCleanup = {
	uploadKind: string;
	s3Key: string | null;
	s3UploadId: string | null;
};

async function cleanupDeletedProjectWebgl(
	projectId: number,
	entryKey: string,
	activeUploads: ActiveUploadCleanup[],
	reason: string,
): Promise<void> {
	if (entryKey) await cleanupWebglEntry(projectId, entryKey, reason);
	const cfg = env();
	await Promise.all(activeUploads.map(async (session) => {
		if (session.s3UploadId && session.s3Key) {
			await abortMultipartUpload(cfg.S3_BUCKET_PROTECTED, session.s3Key, session.s3UploadId).catch((err) => {
				logger().error({ err, projectId, s3Key: session.s3Key }, 'Failed to abort project upload during deletion');
			});
		}
		if (session.uploadKind === 'WEBGL' && session.s3Key) {
			const keys = parseWebglSourceKey(projectId, session.s3Key);
			if (keys) await cleanupWebglDeployment(keys, `${reason}-active-upload`);
		}
	}));
}

export async function deleteWebgl(projectId: number): Promise<void> {
	const { oldEntryKey, cancelledSession } = await repo.clearWebglDeployment(projectId);
	await cleanupDeletedProjectWebgl(
		projectId,
		oldEntryKey,
		cancelledSession ? [cancelledSession] : [],
		'webgl-delete',
	);
}

/** Set a project's poster to the given asset (with validation) */
export async function setPoster(projectId: number, assetId: number) {
	const asset = await repo.findAssetById(assetId);
	assertValidPosterAsset(asset, projectId);
	await repo.setProjectPoster(projectId, assetId);
	return { posterAssetId: assetId };
}

// ── Bulk operations ───────────────────────────────────────

/** Bulk delete projects: remove S3 objects + DB records. NAS originals are untouched. */
export async function bulkDeleteProjects(ids: number[]) {
	const { result, assets, projects, activeUploads } = await repo.bulkDeleteProjectsReturningAssets(ids);

	// Failures go through safeDeleteObject — orphan reaper handles retry.
	await Promise.all(
		assets.map((a) => deleteAssetObjects(a, 'project-bulk-delete')),
	);
	await Promise.all(projects.map((project) => cleanupDeletedProjectWebgl(
		project.id,
		project.webglEntryKey,
		activeUploads.filter((session) => session.projectId === project.id),
		'project-bulk-delete',
	)));

	return {
		deleted: result.count,
		assetsRemoved: assets.length,
		webglBuildsRemoved: projects.filter((project) => project.webglEntryKey).length,
	};
}
