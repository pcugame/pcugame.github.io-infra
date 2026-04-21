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

/**
 * Swap sortOrder of two members atomically.
 * Locks both rows with SELECT ... FOR UPDATE so a concurrent swap can't read stale sortOrder
 * between our read and write. Rows are locked in ascending-id order to avoid deadlock when two
 * swaps target the same pair from opposite directions.
 */
export function swapMemberOrder(memberIdA: number, memberIdB: number, projectId: number) {
	return prisma.$transaction(async (tx) => {
		const [loId, hiId] = memberIdA < memberIdB ? [memberIdA, memberIdB] : [memberIdB, memberIdA];
		const locked = await tx.$queryRaw<{ id: number; sort_order: number }[]>`
			SELECT id, sort_order FROM project_members
			WHERE id IN (${loId}, ${hiId}) AND project_id = ${projectId}
			ORDER BY id
			FOR UPDATE
		`;
		if (locked.length !== 2) return null;
		const a = locked.find((r) => r.id === memberIdA);
		const b = locked.find((r) => r.id === memberIdB);
		if (!a || !b) return null;
		await tx.projectMember.update({ where: { id: memberIdA }, data: { sortOrder: b.sort_order } });
		await tx.projectMember.update({ where: { id: memberIdB }, data: { sortOrder: a.sort_order } });
		return { a: memberIdA, b: memberIdB };
	});
}
