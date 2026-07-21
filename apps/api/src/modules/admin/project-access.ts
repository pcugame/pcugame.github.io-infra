import type { UserRole } from '@pcu/contracts';
import { notFound, forbidden } from '../../shared/errors.js';
import type { Actor } from '../../application/http-input.js';
import { projectAccessRepository } from './project-access.repository.js';

export interface ProjectAccessRecord {
	id: number;
	exhibitionId: number;
	creatorId: number;
	status: string;
}

export interface ProjectAccessRepository {
	findProject(projectId: number): Promise<ProjectAccessRecord | null>;
	isLinkedMember(projectId: number, userId: number): Promise<boolean>;
}

/**
 * Pure permission check — no DB access, fully testable.
 *
 * Rules:
 * - ADMIN / OPERATOR: always allowed (any project, any status).
 * - USER: must be the project creator OR a linked project member.
 *
 * Throws `forbidden` on denial. Does NOT check authentication (caller
 * must ensure the user is logged in before calling this).
 */
export function assertWriteAccess(
	role: UserRole,
	creatorId: number,
	userId: number,
	opts: { isMember?: boolean } = {},
): void {
	if (role === 'ADMIN' || role === 'OPERATOR') return;

	if (creatorId !== userId && !opts.isMember) {
		throw forbidden('Not project owner or member');
	}
}

/**
 * Load a project by ID and verify the current user has write access.
 *
 * - ADMIN / OPERATOR: always allowed.
 * - Other roles: must be the project creator or a linked member (ProjectMember.userId).
 */
export function createProjectAccessService(repository: ProjectAccessRepository) {
	return {
		async loadProjectWithAccess(actor: Actor, projectId: number): Promise<ProjectAccessRecord> {
			const project = await repository.findProject(projectId);
			if (!project) throw notFound('Project not found');

			const isMember = actor.role !== 'ADMIN' && actor.role !== 'OPERATOR'
				? await repository.isLinkedMember(projectId, actor.id)
				: false;

			assertWriteAccess(actor.role, project.creatorId, actor.id, { isMember });
			return project;
		},
	};
}

export const { loadProjectWithAccess } = createProjectAccessService(projectAccessRepository);
