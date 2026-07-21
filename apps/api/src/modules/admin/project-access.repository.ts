import type { PrismaClient } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

export function createProjectAccessRepository(client: PrismaClient) {
	return {
		findProject(projectId: number) {
			return client.project.findUnique({
				where: { id: projectId },
				select: {
					id: true,
					exhibitionId: true,
					creatorId: true,
					status: true,
				},
			});
		},
		async isLinkedMember(projectId: number, userId: number): Promise<boolean> {
			const member = await client.projectMember.findFirst({
				where: { projectId, userId },
				select: { id: true },
			});
			return member !== null;
		},
	};
}

export const projectAccessRepository = createProjectAccessRepository(prisma);
