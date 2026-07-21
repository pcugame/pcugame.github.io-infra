import { notFound } from '../../../shared/errors.js';

export interface MemberServiceDependencies {
	projectExists(projectId: number): Promise<boolean>;
	repository: {
		createMember(data: {
			projectId: number;
			name: string;
			studentId: string;
			sortOrder?: number;
		}): Promise<{ id: number }>;
		findMemberInProject(memberId: number, projectId: number): Promise<{ id: number } | null>;
		updateMember(id: number, patch: { name?: string; studentId?: string; sortOrder?: number }): Promise<unknown>;
		deleteMember(id: number): Promise<unknown>;
		swapMemberOrder(memberIdA: number, memberIdB: number, projectId: number): Promise<unknown | null>;
	};
}

/** Add a member to a project */
export async function addMember(
	deps: MemberServiceDependencies,
	projectId: number,
	data: { name: string; studentId: string; sortOrder?: number },
) {
	if (!await deps.projectExists(projectId)) throw notFound('Project not found');
	const member = await deps.repository.createMember({ projectId, ...data });
	return { id: member.id };
}

/** Update a member. Throws 404 if not found in the given project. */
export async function updateMember(
	deps: MemberServiceDependencies,
	projectId: number,
	memberId: number,
	patch: { name?: string; studentId?: string; sortOrder?: number },
) {
	const member = await deps.repository.findMemberInProject(memberId, projectId);
	if (!member) throw notFound('Member not found');

	await deps.repository.updateMember(member.id, {
		...(patch.name !== undefined ? { name: patch.name } : {}),
		...(patch.studentId !== undefined ? { studentId: patch.studentId } : {}),
		...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
	});
}

/** Delete a member. Throws 404 if not found in the given project. */
export async function deleteMember(deps: MemberServiceDependencies, projectId: number, memberId: number) {
	const member = await deps.repository.findMemberInProject(memberId, projectId);
	if (!member) throw notFound('Member not found');

	await deps.repository.deleteMember(member.id);
}

/** Swap sortOrder of two members. Throws 404 if either is not found. */
export async function swapMemberOrder(
	deps: MemberServiceDependencies,
	projectId: number,
	memberIdA: number,
	memberIdB: number,
) {
	const result = await deps.repository.swapMemberOrder(memberIdA, memberIdB, projectId);
	if (!result) throw notFound('One or both members not found in this project');
}

export function createMemberService(deps: MemberServiceDependencies) {
	return {
		addMember: (projectId: number, data: Parameters<typeof addMember>[2]) => addMember(deps, projectId, data),
		updateMember: (
			projectId: number,
			memberId: number,
			patch: Parameters<typeof updateMember>[3],
		) => updateMember(deps, projectId, memberId, patch),
		deleteMember: (projectId: number, memberId: number) => deleteMember(deps, projectId, memberId),
		swapMemberOrder: (projectId: number, a: number, b: number) => swapMemberOrder(deps, projectId, a, b),
	};
}
