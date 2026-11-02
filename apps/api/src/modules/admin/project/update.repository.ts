import type { PrismaClient } from '../../../generated/prisma/client.js';
import { notFound } from '../../../shared/errors.js';
import { projectDetailInclude } from './detail.projection.js';
import type { ProjectUpdateRepository } from './update.ports.js';

export function createProjectUpdateRepository(client: PrismaClient): ProjectUpdateRepository {
	return {
		runProjectUpdate: (projectId, actor, operation) => client.$transaction(async tx => {
			// Preserve project -> exhibition -> member lock order from #113's access
			// transaction. Policy consumes plain records, never the Prisma client.
			const rows = await tx.$queryRaw<{ id: number }[]>`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
			if (rows.length !== 1) throw notFound('Project not found');
			const project = await tx.project.findUniqueOrThrow({
				where: { id: projectId },
				select: { creatorId: true, exhibitionId: true, status: true, changeRequestDraft: { select: { id: true } } },
			});
			await tx.$queryRaw`SELECT id FROM exhibitions WHERE id = ${project.exhibitionId} FOR UPDATE`;
			const exhibition = await tx.exhibition.findUniqueOrThrow({
				where: { id: project.exhibitionId }, select: { isModificationEnabled: true },
			});
			const members = actor.role === 'ADMIN' || actor.role === 'OPERATOR' ? []
				: await tx.$queryRaw<{ id: number }[]>`SELECT id FROM project_members WHERE project_id = ${projectId} AND user_id = ${actor.id} FOR SHARE`;
			return operation({
				snapshot: { creatorId: project.creatorId, status: project.status,
					isChangeRequestDraft: project.changeRequestDraft !== null,
					isModificationEnabled: exhibition.isModificationEnabled, isMember: members.length > 0 },
				async apply(patch) {
					await tx.project.update({ where: { id: projectId }, data: patch });
					await tx.project.update({ where: { id: projectId }, data: { version: { increment: 1 } } });
					return tx.project.findUniqueOrThrow({ where: { id: projectId }, include: projectDetailInclude });
				},
			});
			// Existing project PATCH uses Prisma defaults and no automatic retry.
			// Do not silently adopt asset deletion's Serializable retry policy.
		}),
	};
}
