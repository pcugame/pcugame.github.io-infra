import type { Actor } from '../../application/http-input.js';
import { notFound } from '../../shared/errors.js';
import {
	assertWriteAccess,
	assertStagingUploadAccess,
	assertOrdinaryProjectMutationAllowed,
} from './project-access.policy.js';
import type { ProjectAccessRepository, ProjectAccessRecord } from './project-access.ports.js';
export function createProjectAccessService(repository: ProjectAccessRepository) {
	return {
		async loadProjectWithAccess(actor: Actor, projectId: number): Promise<ProjectAccessRecord> {
			const project = await repository.findProject(projectId);
			if (!project) throw notFound('Project not found');

			const isMember =
				actor.role !== 'ADMIN' && actor.role !== 'OPERATOR'
					? await repository.isLinkedMember(projectId, actor.id)
					: false;

			assertWriteAccess(actor.role, project.creatorId, actor.id, {
				isMember,
				isModificationEnabled: project.isModificationEnabled !== false,
			});
			assertOrdinaryProjectMutationAllowed(project);
			return project;
		},
		async loadProjectForUpload(actor: Actor, projectId: number): Promise<ProjectAccessRecord> {
			const project = await repository.findProject(projectId);
			if (!project) throw notFound('Project not found');
			if (project.isChangeRequestDraft) {
				assertStagingUploadAccess(actor, project);
				return project;
			}
			const isMember =
				actor.role !== 'ADMIN' && actor.role !== 'OPERATOR'
					? await repository.isLinkedMember(projectId, actor.id)
					: false;
			assertWriteAccess(actor.role, project.creatorId, actor.id, {
				isMember,
				isModificationEnabled: project.isModificationEnabled !== false,
			});
			return project;
		},
	};
}
