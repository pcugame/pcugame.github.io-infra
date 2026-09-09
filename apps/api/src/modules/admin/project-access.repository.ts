import type { PrismaClient } from '../../generated/prisma/client.js';

export function createProjectAccessRepository(client: PrismaClient) {
	return {
		async findProject(projectId: number) {
			const project = await client.project.findUnique({
				where: { id: projectId },
				select: {
					id: true,
					exhibitionId: true,
					creatorId: true,
					status: true,
					exhibition: { select: { isModificationEnabled: true } },
					changeRequestDraft: { select: {
						id: true, actorId: true, state: true,
						project: { select: { creatorId: true, members: { select: { userId: true } } } },
					} },
				},
			});
			return project && ({
				id: project.id,
				exhibitionId: project.exhibitionId,
				creatorId: project.creatorId,
				status: project.status,
				isChangeRequestDraft: project.changeRequestDraft !== null,
				...(project.changeRequestDraft ? {
					changeRequestActorId: project.changeRequestDraft.actorId,
					changeRequestState: project.changeRequestDraft.state,
					changeRequestSourceCreatorId: project.changeRequestDraft.project?.creatorId,
					changeRequestSourceMemberIds: project.changeRequestDraft.project?.members.map((member) => member.userId) ?? [],
				} : {}),
				isModificationEnabled: project.exhibition.isModificationEnabled,
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
