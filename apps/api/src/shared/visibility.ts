import type { UserRole, Visibility } from '@pcu/contracts';

export type VisibilityActor = { id: number; role: UserRole } | null;
export interface VisibilityProject {
	visibility: Visibility;
	status: string;
	creatorId: number;
	members: ReadonlyArray<{ userId: number | null }>;
	exhibition: { visibility: Visibility; isModificationEnabled?: boolean };
}
export function isVisibilityStaff(actor: VisibilityActor): boolean {
	return actor?.role === 'ADMIN' || actor?.role === 'OPERATOR';
}
export function canReadVisibility(actor: VisibilityActor, visibility: Visibility): boolean {
	return visibility === 'PUBLIC' || (visibility === 'AUTHENTICATED' && actor !== null)
		|| (visibility === 'STAFF' && isVisibilityStaff(actor));
}
export function isProjectRelated(actor: VisibilityActor, project: Pick<VisibilityProject, 'creatorId' | 'members'>): boolean {
	return actor !== null && (project.creatorId === actor.id || project.members.some((member) => member.userId === actor.id));
}
export function canReadProject(actor: VisibilityActor, project: VisibilityProject, options: { allowDraft?: boolean } = {}): boolean {
	if (project.status !== 'PUBLISHED' && project.status !== 'ARCHIVED') {
		return options.allowDraft === true && (isVisibilityStaff(actor) || isProjectRelated(actor, project));
	}
	return isProjectRelated(actor, project)
		|| (canReadVisibility(actor, project.exhibition.visibility) && canReadVisibility(actor, project.visibility));
}
export function canChangeProjectVisibility(actor: VisibilityActor, project: Pick<VisibilityProject, 'creatorId' | 'members' | 'exhibition'>): boolean {
	return isVisibilityStaff(actor) || (project.exhibition.isModificationEnabled !== false && isProjectRelated(actor, project));
}
export function readableVisibilities(actor: VisibilityActor): Visibility[] {
	return isVisibilityStaff(actor) ? ['PUBLIC', 'AUTHENTICATED', 'STAFF'] : actor ? ['PUBLIC', 'AUTHENTICATED'] : ['PUBLIC'];
}
