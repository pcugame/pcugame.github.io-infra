import type { AssetKind, ProjectStatus } from '@pcu/contracts';
import type { AdminProjectItem, AdminProjectListQuery, AdminProjectListResponse } from '@pcu/contracts';
import { forbidden, notFound } from '../../../shared/errors.js';
import { assertValidPosterAsset } from '../../../shared/poster-validation.js';
import { effectiveIsIncomplete } from '../../../shared/project-completeness.js';
import { parseWebglSourceKey } from '../../webgl/paths.js';
import type { createProjectSerializer } from './serializer.js';
import type { ActiveUploadCleanup, ProjectCrudRepository } from './ports.js';

type ProjectSerializer = ReturnType<typeof createProjectSerializer>['serializeProjectDetail'];

export interface ProjectServiceDependencies {
	repository: ProjectCrudRepository;
	serializeProjectDetail: ProjectSerializer;
	deleteAssetObjects(
		asset: { id: number; projectId?: number; kind: AssetKind; storageKey: string; playbackStorageKey: string | null },
		reason: string,
	): Promise<void>;
	abortMultipart(key: string, uploadId: string): Promise<void>;
	cleanupWebglEntry(projectId: number, entryKey: string, reason: string): Promise<void>;
	cleanupWebglDeployment(
		keys: NonNullable<ReturnType<typeof parseWebglSourceKey>>,
		reason: string,
	): Promise<void>;
	logger: { error(context: Record<string, unknown>, message: string): void };
}

// ── Business logic ──────────────────────────────────────────

/** List projects visible to the current user */
export async function listProjects(
	deps: ProjectServiceDependencies,
	userId: number,
	userRole: string,
	options: AdminProjectListQuery = {},
): Promise<AdminProjectListResponse> {
	const listOptions = {
		page: options.page ?? 1,
		limit: options.limit ?? 20,
		search: options.search,
		year: options.year,
		status: options.status,
		sort: options.sort ?? 'createdAt',
		order: options.order ?? 'desc',
	};
	const isPrivileged = userRole === 'ADMIN' || userRole === 'OPERATOR';
	const { items: projects, totalItems } = await deps.repository.findProjectsForUser(userId, isPrivileged, listOptions);
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
export async function getProjectDetail(
	deps: ProjectServiceDependencies,
	projectId: number,
	userId: number,
	userRole: string,
) {
	const project = await deps.repository.findProjectById(projectId);
	if (!project) throw notFound('Project not found');

	if (userRole !== 'ADMIN' && userRole !== 'OPERATOR' && project.creatorId !== userId) {
		const isMember = !!(await deps.repository.isMemberOfProject(project.id, userId));
		if (!isMember) throw forbidden('Not your project');
	}

	return deps.serializeProjectDetail(project);
}

/** Partial-update a project */
export async function updateProject(
	deps: ProjectServiceDependencies,
	projectId: number,
	patch: {
		title?: string; summary?: string; description?: string;
		isIncomplete?: boolean; status?: ProjectStatus; sortOrder?: number;
	},
) {
	const updated = await deps.repository.updateProject(projectId, {
		...(patch.title !== undefined ? { title: patch.title } : {}),
		...(patch.summary !== undefined ? { summary: patch.summary } : {}),
		...(patch.description !== undefined ? { description: patch.description } : {}),
		...(patch.isIncomplete !== undefined ? { isIncomplete: patch.isIncomplete } : {}),
		...(patch.status !== undefined ? { status: patch.status } : {}),
		...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
	});

	return deps.serializeProjectDetail(updated);
}

/** Delete a project and its associated asset files from S3 */
export async function deleteProject(deps: ProjectServiceDependencies, projectId: number) {
	const { assets, webglEntryKey, activeUploads } = await deps.repository.deleteProjectReturningAssets(projectId);
	await Promise.all(
		assets.map((asset) => deps.deleteAssetObjects({ ...asset, projectId }, 'project-delete')),
	);
	await cleanupDeletedProjectWebgl(deps, projectId, webglEntryKey, activeUploads, 'project-delete');
}

async function cleanupDeletedProjectWebgl(
	deps: ProjectServiceDependencies,
	projectId: number,
	entryKey: string,
	activeUploads: ActiveUploadCleanup[],
	reason: string,
): Promise<void> {
	if (entryKey) await deps.cleanupWebglEntry(projectId, entryKey, reason);
	await Promise.all(activeUploads.map(async (session) => {
		if (session.s3UploadId && session.s3Key) {
			await deps.abortMultipart(session.s3Key, session.s3UploadId).catch((err) => {
				deps.logger.error({ err, projectId, s3Key: session.s3Key }, 'Failed to abort project upload during deletion');
			});
		}
		if (session.uploadKind === 'WEBGL' && session.s3Key) {
			const keys = parseWebglSourceKey(projectId, session.s3Key);
			if (keys) await deps.cleanupWebglDeployment(keys, `${reason}-active-upload`);
		}
	}));
}

export async function deleteWebgl(deps: ProjectServiceDependencies, projectId: number): Promise<void> {
	const { oldEntryKey, cancelledSession } = await deps.repository.clearWebglDeployment(projectId);
	await cleanupDeletedProjectWebgl(
		deps,
		projectId,
		oldEntryKey,
		cancelledSession ? [cancelledSession] : [],
		'webgl-delete',
	);
}

/** Set a project's poster to the given asset (with validation) */
export async function setPoster(deps: ProjectServiceDependencies, projectId: number, assetId: number) {
	const asset = await deps.repository.findAssetById(assetId);
	assertValidPosterAsset(asset, projectId);
	await deps.repository.setProjectPoster(projectId, assetId);
	return { posterAssetId: assetId };
}

// ── Bulk operations ───────────────────────────────────────

/** Bulk delete projects: remove S3 objects + DB records. NAS originals are untouched. */
export async function bulkDeleteProjects(deps: ProjectServiceDependencies, ids: number[]) {
	const { result, assets, projects, activeUploads } = await deps.repository.bulkDeleteProjectsReturningAssets(ids);

	// Failures go through safeDeleteObject — orphan reaper handles retry.
	await Promise.all(
		assets.map((a) => deps.deleteAssetObjects(a, 'project-bulk-delete')),
	);
	await Promise.all(projects.map((project) => cleanupDeletedProjectWebgl(
		deps,
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

type WithoutDependencies<T extends (deps: ProjectServiceDependencies, ...args: never[]) => unknown> =
	T extends (deps: ProjectServiceDependencies, ...args: infer Rest) => infer Result
		? (...args: Rest) => Result
		: never;

/** Build project CRUD use-cases from repository and cleanup ports. */
export function createProjectService(deps: ProjectServiceDependencies) {
	return {
		listProjects: ((...args) => listProjects(deps, ...args)) as WithoutDependencies<typeof listProjects>,
		getProjectDetail: ((...args) => getProjectDetail(deps, ...args)) as WithoutDependencies<typeof getProjectDetail>,
		updateProject: ((...args) => updateProject(deps, ...args)) as WithoutDependencies<typeof updateProject>,
		deleteProject: ((...args) => deleteProject(deps, ...args)) as WithoutDependencies<typeof deleteProject>,
		deleteWebgl: ((...args) => deleteWebgl(deps, ...args)) as WithoutDependencies<typeof deleteWebgl>,
		setPoster: ((...args) => setPoster(deps, ...args)) as WithoutDependencies<typeof setPoster>,
		bulkDeleteProjects: ((...args) => bulkDeleteProjects(deps, ...args)) as WithoutDependencies<typeof bulkDeleteProjects>,
	};
}
