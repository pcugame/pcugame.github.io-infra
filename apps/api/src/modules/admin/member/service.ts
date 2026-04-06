import { notFound } from '../../../shared/errors.js';
import * as repo from './repository.js';

/** Add a member to a project */
export async function addMember(projectId: number, data: { name: string; studentId: string; sortOrder?: number }) {
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
