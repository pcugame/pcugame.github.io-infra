import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { Actor } from '../../../application/http-input.js';
import { assertProjectWriteAccessInTransaction } from '../project-access.service.js';

export function createMemberRepository(client: PrismaClient) {
	return {
		createMember(data: {
			projectId: number;
			name: string;
			studentId: string;
			sortOrder?: number;
		}, actor: Actor) {
			return client.$transaction(async (tx) => {
				await assertProjectWriteAccessInTransaction(tx, actor, data.projectId);
				const member = await tx.projectMember.create({ data });
				await tx.project.update({ where: { id: data.projectId }, data: { version: { increment: 1 } } });
				return member;
			});
		},

		findMemberInProject(memberId: number, projectId: number) {
			return client.projectMember.findFirst({ where: { id: memberId, projectId } });
		},

		updateMember(id: number, projectId: number, data: { name?: string; studentId?: string; sortOrder?: number }, actor: Actor) {
			return client.$transaction(async (tx) => {
				await assertProjectWriteAccessInTransaction(tx, actor, projectId);
				const member = await tx.projectMember.updateMany({ where: { id, projectId }, data });
				if (member.count !== 1) throw new Error('Member not found in project');
				await tx.project.update({ where: { id: projectId }, data: { version: { increment: 1 } } });
				return member;
			});
		},

		deleteMember(id: number, projectId: number, actor: Actor) {
			return client.$transaction(async (tx) => {
				await assertProjectWriteAccessInTransaction(tx, actor, projectId);
				const member = await tx.projectMember.deleteMany({ where: { id, projectId } });
				if (member.count !== 1) throw new Error('Member not found in project');
				await tx.project.update({ where: { id: projectId }, data: { version: { increment: 1 } } });
				return member;
			});
		},

		/** Lock both rows in stable ID order before atomically swapping sortOrder. */
		swapMemberOrder(memberIdA: number, memberIdB: number, projectId: number, actor: Actor) {
			return client.$transaction(async (tx) => {
				await assertProjectWriteAccessInTransaction(tx, actor, projectId);
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
				await tx.project.update({ where: { id: projectId }, data: { version: { increment: 1 } } });
				await tx.projectMember.update({
					where: { id: memberIdB },
					data: { sortOrder: a.sort_order },
				});
				return { a: memberIdA, b: memberIdB };
			});
		},
	};
}
