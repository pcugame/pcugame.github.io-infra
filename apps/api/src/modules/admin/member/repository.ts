import { prisma } from '../../../lib/prisma.js';

/** Create a new project member */
export function createMember(data: {
	projectId: number;
	name: string;
	studentId: string;
	sortOrder?: number;
}) {
	return prisma.projectMember.create({ data });
}

/** Find a member by ID scoped to a project */
export function findMemberInProject(memberId: number, projectId: number) {
	return prisma.projectMember.findFirst({
		where: { id: memberId, projectId },
	});
}

/** Partial-update a member record */
export function updateMember(
	id: number,
	data: { name?: string; studentId?: string; sortOrder?: number; userId?: number | null },
) {
	return prisma.projectMember.update({ where: { id }, data });
}

/** Delete a member by primary key */
export function deleteMember(id: number) {
	return prisma.projectMember.delete({ where: { id } });
}

/** Swap sortOrder of two members atomically */
export function swapMemberOrder(memberIdA: number, memberIdB: number, projectId: number) {
	return prisma.$transaction(async (tx) => {
		const a = await tx.projectMember.findFirst({ where: { id: memberIdA, projectId } });
		const b = await tx.projectMember.findFirst({ where: { id: memberIdB, projectId } });
		if (!a || !b) return null;
		await tx.projectMember.update({ where: { id: memberIdA }, data: { sortOrder: b.sortOrder } });
		await tx.projectMember.update({ where: { id: memberIdB }, data: { sortOrder: a.sortOrder } });
		return { a: memberIdA, b: memberIdB };
	});
}
