import { serializeAwards } from '../../awards/serialization.js';
import { capabilities } from './capabilities.js';
import { updateProject } from './update.service.js';
import type { ProjectUpdateDependencies } from './update.ports.js';
import { projectRequiredAssets } from '../../../shared/project-required-assets.js';
import type { AdminProjectItem, AdminProjectListQuery, AdminProjectListResponse } from '@pcu/contracts';
import { forbidden, notFound } from '../../../shared/errors.js';
import { effectiveIsIncomplete } from '../../../shared/project-completeness.js';
import type { createProjectSerializer } from './serializer.js';
import type { ActiveUploadCleanup, ProjectCrudRepository } from './ports.js';
import type { Actor } from '../../../application/http-input.js';

type ProjectSerializer = ReturnType<typeof createProjectSerializer>['serializeProjectDetail'];

export interface ProjectServiceDependencies extends ProjectUpdateDependencies {
	repository: ProjectCrudRepository;
 publicAssetOrigin?: string;
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
		requiredAssets: projectRequiredAssets(p, deps.deletionBuckets.publicBucket),
		id: p.id,
 awards: serializeAwards(p.awards, deps.publicAssetOrigin ?? "http://localhost", deps.deletionBuckets.publicBucket),
		visibility: p.visibility,
		exhibitionVisibility: p.exhibition.visibility,
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
	return { ...deps.serializeProjectDetail(project), ...capabilities(project, userId, userRole), canEditWebglDisplay: (userRole === 'ADMIN' || userRole === 'OPERATOR') || (project.creatorId === userId && project.exhibition.isModificationEnabled !== false) };
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
