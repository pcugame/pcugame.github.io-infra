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
