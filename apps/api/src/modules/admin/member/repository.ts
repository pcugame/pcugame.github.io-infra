import type { PrismaClient } from '../../../generated/prisma/client.js';

export function createMemberRepository(client: PrismaClient) {
	return {
		createMember(data: {
			projectId: number;
			name: string;
			studentId: string;
			sortOrder?: number;
		}) {
			return client.projectMember.create({ data });
		},

		findMemberInProject(memberId: number, projectId: number) {
			return client.projectMember.findFirst({ where: { id: memberId, projectId } });
		},

		updateMember(id: number, data: { name?: string; studentId?: string; sortOrder?: number }) {
			return client.projectMember.update({ where: { id }, data });
		},

		deleteMember(id: number) {
			return client.projectMember.delete({ where: { id } });
		},

		/** Lock both rows in stable ID order before atomically swapping sortOrder. */
		swapMemberOrder(memberIdA: number, memberIdB: number, projectId: number) {
			return client.$transaction(async (tx) => {
				const [loId, hiId] = memberIdA < memberIdB
					? [memberIdA, memberIdB]
					: [memberIdB, memberIdA];
				const locked = await tx.$queryRaw<{ id: number; sort_order: number }[]>`
					SELECT id, sort_order FROM project_members
					WHERE id IN (${loId}, ${hiId}) AND project_id = ${projectId}
					ORDER BY id
					FOR UPDATE
				`;
				if (locked.length !== 2) return null;
				const a = locked.find((row) => row.id === memberIdA);
				const b = locked.find((row) => row.id === memberIdB);
				if (!a || !b) return null;
				await tx.projectMember.update({
					where: { id: memberIdA },
					data: { sortOrder: b.sort_order },
				});
				await tx.projectMember.update({
					where: { id: memberIdB },
					data: { sortOrder: a.sort_order },
				});
				return { a: memberIdA, b: memberIdB };
			});
		},
	};
}
