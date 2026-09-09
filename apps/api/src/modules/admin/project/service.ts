import type { ProjectStatus } from '@pcu/contracts';
import type { AdminProjectItem, AdminProjectListQuery, AdminProjectListResponse } from '@pcu/contracts';
import { forbidden, notFound } from '../../../shared/errors.js';
import { effectiveIsIncomplete } from '../../../shared/project-completeness.js';
import type { createProjectSerializer } from './serializer.js';
import type { ActiveUploadCleanup, ProjectCrudRepository } from './ports.js';
import type { Actor } from '../../../application/http-input.js';

type ProjectSerializer = ReturnType<typeof createProjectSerializer>['serializeProjectDetail'];

export interface ProjectServiceDependencies {
	repository: ProjectCrudRepository;
	serializeProjectDetail: ProjectSerializer;
	deletionBuckets: { publicBucket: string; protectedBucket: string };
	abortMultipart(key: string, uploadId: string): Promise<void>;
	wakeDeletionWorker(): void;
	wakeMaintenance(): void;
	logger: {
		error(context: Record<string, unknown>, message: string): void;
		warn?(context: Record<string, unknown>, message: string): void;
	};
	recordPostCommitCleanupFailure?: () => void;
}

function wakeCommittedCleanup(deps: ProjectServiceDependencies): void {
	deps.wakeDeletionWorker();
	deps.wakeMaintenance();
}


function capabilities(project: { status?: string; creatorId: number; members: Array<{ userId: number | null }>; exhibition: { isModificationEnabled?: boolean } }, userId: number, role: string) {
	const isModificationEnabled = project.exhibition.isModificationEnabled !== false;
	const privileged = role === 'ADMIN' || role === 'OPERATOR';
	const related = project.creatorId === userId || project.members.some((member) => member.userId === userId);
	const direct = privileged || (isModificationEnabled && related);
	return {
		isModificationEnabled,
		canEdit: direct,
		canDelete: direct,
		canRequestChange: !privileged && !isModificationEnabled && related && project.status !== 'DRAFT',
	};
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
		isIncomplete: effectiveIsIncomplete(
			p.isIncomplete,
			p.assets,
			p.poster ? {
				...p.poster,
				hasReadyOriginal: p.poster.representations?.some((representation) => (
					representation.role === 'ORIGINAL'
				)) ?? false,
			} : null,
		),
		status: p.status,
		createdByUserName: p.creator.name || undefined,
		memberNames: p.members.map((m) => m.name),
		memberStudentIds: p.members.map((m) => m.studentId),
		updatedAt: p.updatedAt.toISOString(),
		...capabilities(p, userId, userRole),
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
	if (project.changeRequestDraft) throw notFound('Project not found');

	if (userRole !== 'ADMIN' && userRole !== 'OPERATOR' && project.creatorId !== userId) {
		const isMember = !!(await deps.repository.isMemberOfProject(project.id, userId));
		if (!isMember) throw forbidden('Not your project');
	}
	return { ...deps.serializeProjectDetail(project), ...capabilities(project, userId, userRole) };
}

/** Partial-update a project */
export async function updateProject(
	deps: ProjectServiceDependencies,
	projectId: number,
	patch: {
		title?: string; summary?: string; description?: string;
		isIncomplete?: boolean; status?: ProjectStatus; sortOrder?: number;
	},
	actor: Actor,
) {
	const updated = await deps.repository.updateProject(projectId, {
		...(patch.title !== undefined ? { title: patch.title } : {}),
		...(patch.summary !== undefined ? { summary: patch.summary } : {}),
		...(patch.description !== undefined ? { description: patch.description } : {}),
		...(patch.isIncomplete !== undefined ? { isIncomplete: patch.isIncomplete } : {}),
		...(patch.status !== undefined ? { status: patch.status } : {}),
		...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
	}, actor);
	return { ...deps.serializeProjectDetail(updated), ...capabilities(updated, actor.id, actor.role) };
}

/** Delete a project and its associated asset files from S3 */
export async function deleteProject(deps: ProjectServiceDependencies, projectId: number, actor: Actor) {
	const reason = 'project-delete';
	const { activeUploads } = await deps.repository.deleteProjectReturningAssets(projectId, {
		...deps.deletionBuckets,
		reason,
	}, actor);
	wakeCommittedCleanup(deps);
	await abortTrackedMultipartUploads(deps, activeUploads, projectId);
}

async function abortTrackedMultipartUploads(
	deps: ProjectServiceDependencies,
	activeUploads: ActiveUploadCleanup[],
	projectId?: number,
): Promise<void> {
	await Promise.all(activeUploads.map(async (session) => {
		if (session.uploadId && session.objectKey) {
			await deps.abortMultipart(session.objectKey, session.uploadId).catch((err) => {
				deps.recordPostCommitCleanupFailure?.();
				deps.logger.error(
					{ err, projectId: projectId ?? session.projectId, objectKey: session.objectKey },
					'Best-effort tracked multipart abort failed; durable task retained',
				);
			});
		}
	}));
}

export async function deleteWebgl(deps: ProjectServiceDependencies, projectId: number, actor: Actor): Promise<void> {
	const reason = 'webgl-delete';
	const { cancelledSession } = await deps.repository.clearWebglDeployment(projectId, {
		...deps.deletionBuckets,
		reason,
	}, actor);
	wakeCommittedCleanup(deps);
	await abortTrackedMultipartUploads(deps, cancelledSession ? [cancelledSession] : [], projectId);
}

/** Set a project's poster; repository validation and pointer update share one transaction. */
export async function setPoster(deps: ProjectServiceDependencies, projectId: number, assetId: number, actor: Actor) {
	await deps.repository.setProjectPoster(projectId, assetId, actor);
	return { posterAssetId: assetId };
}

// ── Bulk operations ───────────────────────────────────────

/** Bulk delete projects: remove S3 objects + DB records. NAS originals are untouched. */
export async function bulkDeleteProjects(deps: ProjectServiceDependencies, ids: number[]) {
	const reason = 'project-bulk-delete';
	const { result, assets, projects, activeUploads } = await deps.repository.bulkDeleteProjectsReturningAssets(ids, {
		...deps.deletionBuckets,
		reason,
	});

	// Every target and multipart abort task committed in the transaction above.
	// One coalesced wake is independent of both asset count and backlog size.
	wakeCommittedCleanup(deps);
	await abortTrackedMultipartUploads(deps, activeUploads);

	return {
		deleted: result.count,
		assetsRemoved: assets.length,
		webglBuildsRemoved: projects.filter((project) => project.currentWebglDeploymentId != null).length,
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
		setVideoOrder: (projectId: number, expectedOrder: number[], order: number[], actor: Actor) => deps.repository.setProjectVideoOrder(projectId, expectedOrder, order, actor),
		setPoster: ((...args) => setPoster(deps, ...args)) as WithoutDependencies<typeof setPoster>,
		bulkDeleteProjects: ((...args) => bulkDeleteProjects(deps, ...args)) as WithoutDependencies<typeof bulkDeleteProjects>,
	};
}
