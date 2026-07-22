import type { UserRole } from '@pcu/contracts';
import type { Actor } from '../../application/http-input.js';
import { forbidden, notFound } from '../../shared/errors.js';

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

/** Pure permission check with no adapter dependency. */
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
