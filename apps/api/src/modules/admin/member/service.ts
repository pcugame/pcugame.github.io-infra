import { notFound } from '../../../shared/errors.js';
import * as projectRepo from '../project/repository.js';
import * as repo from './repository.js';

/** Add a member to a project */
export async function addMember(projectId: number, data: { name: string; studentId: string; sortOrder?: number }) {
	const project = await projectRepo.findProjectById(projectId);
	if (!project) throw notFound('Project not found');
	const member = await repo.createMember({ projectId, ...data });
	return { id: member.id };
}

/** Update a member. Throws 404 if not found in the given project. */
export async function updateMember(
	projectId: number,
	memberId: number,
	patch: { name?: string; studentId?: string; sortOrder?: number; userId?: number | null },
) {
	const member = await repo.findMemberInProject(memberId, projectId);
	if (!member) throw notFound('Member not found');

	await repo.updateMember(member.id, {
		...(patch.name !== undefined ? { name: patch.name } : {}),
		...(patch.studentId !== undefined ? { studentId: patch.studentId } : {}),
		...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
		...(patch.userId !== undefined ? { userId: patch.userId } : {}),
	});
}

/** Delete a member. Throws 404 if not found in the given project. */
export async function deleteMember(projectId: number, memberId: number) {
	const member = await repo.findMemberInProject(memberId, projectId);
	if (!member) throw notFound('Member not found');

	await repo.deleteMember(member.id);
}

/** Swap sortOrder of two members. Throws 404 if either is not found. */
export async function swapMemberOrder(projectId: number, memberIdA: number, memberIdB: number) {
	const result = await repo.swapMemberOrder(memberIdA, memberIdB, projectId);
	if (!result) throw notFound('One or both members not found in this project');
}
