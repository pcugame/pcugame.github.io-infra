import { notFound } from '../../../shared/errors.js';
import type { Actor } from '../../../application/http-input.js';

export interface MemberServiceDependencies {
	projectExists(projectId: number): Promise<boolean>;
	repository: {
		createMember(data: {
			projectId: number;
			name: string;
			studentId: string;
			sortOrder?: number;
		}, actor: Actor): Promise<{ id: number }>;
		findMemberInProject(memberId: number, projectId: number): Promise<{ id: number } | null>;
		updateMember(id: number, projectId: number, patch: { name?: string; studentId?: string; sortOrder?: number }, actor: Actor): Promise<unknown>;
		deleteMember(id: number, projectId: number, actor: Actor): Promise<unknown>;
		swapMemberOrder(memberIdA: number, memberIdB: number, projectId: number, actor: Actor): Promise<unknown | null>;
	};
}

/** Add a member to a project */
export async function addMember(
	deps: MemberServiceDependencies,
	projectId: number,
	data: { name: string; studentId: string; sortOrder?: number }, actor: Actor,
) {
	if (!await deps.projectExists(projectId)) throw notFound('Project not found');
	const member = await deps.repository.createMember({ projectId, ...data }, actor);
	return { id: member.id };
}

/** Update a member. Throws 404 if not found in the given project. */
export async function updateMember(
	deps: MemberServiceDependencies,
	projectId: number,
	memberId: number,
	patch: { name?: string; studentId?: string; sortOrder?: number }, actor: Actor,
) {
	const member = await deps.repository.findMemberInProject(memberId, projectId);
	if (!member) throw notFound('Member not found');

	await deps.repository.updateMember(member.id, projectId, {
		...(patch.name !== undefined ? { name: patch.name } : {}),
		...(patch.studentId !== undefined ? { studentId: patch.studentId } : {}),
		...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
	}, actor);
}

/** Delete a member. Throws 404 if not found in the given project. */
export async function deleteMember(deps: MemberServiceDependencies, projectId: number, memberId: number, actor: Actor) {
	const member = await deps.repository.findMemberInProject(memberId, projectId);
	if (!member) throw notFound('Member not found');

	await deps.repository.deleteMember(member.id, projectId, actor);
}

/** Swap sortOrder of two members. Throws 404 if either is not found. */
export async function swapMemberOrder(
	deps: MemberServiceDependencies,
	projectId: number,
	memberIdA: number,
	memberIdB: number, actor: Actor,
) {
	const result = await deps.repository.swapMemberOrder(memberIdA, memberIdB, projectId, actor);
	if (!result) throw notFound('One or both members not found in this project');
}

export function createMemberService(deps: MemberServiceDependencies) {
	return {
		addMember: (projectId: number, data: Parameters<typeof addMember>[2], actor: Actor) => addMember(deps, projectId, data, actor),
		updateMember: (
			projectId: number,
			memberId: number,
			patch: Parameters<typeof updateMember>[3], actor: Actor,
		) => updateMember(deps, projectId, memberId, patch, actor),
		deleteMember: (projectId: number, memberId: number, actor: Actor) => deleteMember(deps, projectId, memberId, actor),
		swapMemberOrder: (projectId: number, a: number, b: number, actor: Actor) => swapMemberOrder(deps, projectId, a, b, actor),
	};
}
