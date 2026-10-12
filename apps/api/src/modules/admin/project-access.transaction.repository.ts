import type { Prisma } from '../../generated/prisma/client.js';
import type { Actor } from '../../application/http-input.js';
import { forbidden, notFound } from '../../shared/errors.js';
import { assertWriteAccess, assertStagingUploadAccess } from './project-access.policy.js';
import type { ProjectAccessRecord } from './project-access.ports.js';
/**
 * Recheck the policy inside the transaction that performs a mutation.  Route
 * checks are useful feedback, but cannot safely authorize a write after an
 * operator closes an exhibition or removes a member.
 */
export async function assertProjectWriteAccessInTransaction(
	tx: Prisma.TransactionClient,
	actor: Actor,
	projectId: number,
): Promise<ProjectAccessRecord> {
	const rows = await tx.$queryRaw<Array<{ id: number; exhibition_id: number }>>`
		SELECT id, exhibition_id FROM projects WHERE id = ${projectId} FOR UPDATE
	`;
	if (rows.length !== 1) throw notFound('Project not found');
	const project = await tx.project.findUniqueOrThrow({
		where: { id: projectId },
		select: {
			id: true, exhibitionId: true, creatorId: true, status: true,
			exhibition: { select: { isModificationEnabled: true } },
			changeRequestDraft: { select: { id: true } },
		},
	});
	// Lock the policy source too.  Year closure and the following mutation are
	// therefore serialized instead of being a time-of-check/time-of-use race.
	await tx.$queryRaw`SELECT id FROM exhibitions WHERE id = ${project.exhibitionId} FOR UPDATE`;
	const exhibition = await tx.exhibition.findUniqueOrThrow({
		where: { id: project.exhibitionId }, select: { isModificationEnabled: true },
	});
	if (project.changeRequestDraft) {
		throw forbidden('Staged change-request projects cannot be modified through project routes');
	}
	const memberRows = actor.role === 'ADMIN' || actor.role === 'OPERATOR'
		? []
		: await tx.$queryRaw<Array<{ id: number }>>`
			SELECT id FROM project_members WHERE project_id = ${projectId} AND user_id = ${actor.id} FOR SHARE
		`;
	assertWriteAccess(actor.role, project.creatorId, actor.id, {
		isMember: memberRows.length > 0,
		isModificationEnabled: exhibition.isModificationEnabled,
	});
	return {
		id: project.id,
		exhibitionId: project.exhibitionId,
		creatorId: project.creatorId,
		status: project.status,
		isChangeRequestDraft: false,
		isModificationEnabled: exhibition.isModificationEnabled,
	};
}

/** Upload sessions have one narrow exception: a requester's DRAFT staging
 * project may receive private files while its source exhibition is closed. */
export async function assertProjectUploadWriteAccessInTransaction(
	tx: Prisma.TransactionClient,
	actor: Actor,
	projectId: number,
): Promise<void> {
	// Probe without a lock so a staging upload follows the same source -> stage
	// lock order as request submit/approval. Holding the stage first can deadlock
	// with an approver that already holds the source project.
	const stagedProbe = await tx.project.findUnique({
		where: { id: projectId },
		select: { changeRequestDraft: { select: { projectId: true } } },
	});
	if (!stagedProbe) throw notFound('Project not found');
	if (stagedProbe.changeRequestDraft?.projectId !== null && stagedProbe.changeRequestDraft?.projectId !== undefined) {
		const sourceId = stagedProbe.changeRequestDraft.projectId;
		await tx.$queryRaw`SELECT id FROM projects WHERE id = ${sourceId} FOR UPDATE`;
		await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
		const request = await tx.projectChangeRequest.findUnique({
			where: { stagingProjectId: projectId },
			select: {
				actorId: true, state: true,
				project: { select: { creatorId: true, members: { select: { userId: true } } } },
			},
		});
		const source = request?.project;
  assertStagingUploadAccess(actor, {
   changeRequestState: request?.state, changeRequestActorId: request?.actorId,
   changeRequestSourceCreatorId: source?.creatorId,
   changeRequestSourceMemberIds: source?.members.map(member => member.userId) ?? [],
  });
		return;
	}
	await tx.$queryRaw`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`;
	const project = await tx.project.findUniqueOrThrow({
		where: { id: projectId },
		select: {
			creatorId: true,
			exhibitionId: true,
			exhibition: { select: { isModificationEnabled: true } },
		},
	});
	await tx.$queryRaw`SELECT id FROM exhibitions WHERE id = ${project.exhibitionId} FOR UPDATE`;
	const exhibition = await tx.exhibition.findUniqueOrThrow({
		where: { id: project.exhibitionId }, select: { isModificationEnabled: true },
	});
	const memberRows = actor.role === 'ADMIN' || actor.role === 'OPERATOR' ? []
		: await tx.$queryRaw<Array<{ id: number }>>`
			SELECT id FROM project_members WHERE project_id = ${projectId} AND user_id = ${actor.id} FOR SHARE
		`;
	assertWriteAccess(actor.role, project.creatorId, actor.id, {
		isMember: memberRows.length > 0,
		isModificationEnabled: exhibition.isModificationEnabled,
	});
}
