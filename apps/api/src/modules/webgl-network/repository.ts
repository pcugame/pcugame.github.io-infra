import { validateWebglNetworkOrigin, type CreateWebglNetworkRequest, type WebglNetworkRequest } from '@pcu/contracts';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Actor } from '../../application/http-input.js';
import { conflict, forbidden, notFound, isUniqueConstraintError } from '../../shared/errors.js';
import { assertProjectWriteAccessInTransaction } from '../admin/project-access.service.js';

const eventsInclude = { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } satisfies Prisma.WebglNetworkRequestInclude;
type RequestRow = Prisma.WebglNetworkRequestGetPayload<{ include: typeof eventsInclude }>;
function present(row: RequestRow): WebglNetworkRequest {
 return {
  ...row, createdAt: row.createdAt.toISOString(), reviewedAt: row.reviewedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  events: row.events.map(event => ({
   id: event.id, action: event.action as 'APPROVE' | 'REJECT' | 'REVOKE', actorId: event.actorId,
   reason: event.reason, policyVersion: event.policyVersion, createdAt: event.createdAt.toISOString(),
  })),
 };
}
function staff(actor: Actor) {
 if (!['ADMIN', 'OPERATOR'].includes(actor.role)) throw forbidden('Administrator review is required');
}
export function createWebglNetworkRepository(client: PrismaClient) {
 return {
  listOwner: async (actor: Actor, projectId: number) => client.$transaction(async tx => {
   const project = await tx.project.findUnique({ where: { id: projectId }, include: { members: true, changeRequestDraft: true } });
   if (!project || project.changeRequestDraft) throw notFound();
   if (project.creatorId !== actor.id && !project.members.some(member => member.userId === actor.id)) throw forbidden();
   const rows = await tx.webglNetworkRequest.findMany({ where: { projectId }, include: eventsInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
   return { items: rows.map(present), policyVersion: project.webglNetworkPolicyVersion };
  }),
  listAdmin: async (actor: Actor) => {
   staff(actor);
   return { items: (await client.webglNetworkRequest.findMany({ include: eventsInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] })).map(present), policyVersion: null };
  },
  create: async (actor: Actor, projectId: number, input: CreateWebglNetworkRequest) => {
   try {
    return await client.$transaction(async tx => {
     const project = await assertProjectWriteAccessInTransaction(tx, actor, projectId);
     // Staff privileges do not turn an unrelated administrator into the owner.
     const related = project.creatorId === actor.id || await tx.projectMember.findFirst({ where: { projectId, userId: actor.id } });
     if (!related) throw forbidden('Only the creator or linked members may request connections');
     if (project.isModificationEnabled === false) throw forbidden('Project modifications are closed for this exhibition');
     if (await tx.webglNetworkRequest.findFirst({ where: { projectId, origin: input.origin, state: { in: ['PENDING', 'APPROVED'] } } })) throw conflict('An active request already exists for this origin');
     const source = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { title: true } });
     return present(await tx.webglNetworkRequest.create({ data: {
      ...input, projectId, originalProjectId: projectId, projectTitle: source.title, requesterId: actor.id,
     }, include: eventsInclude }));
    });
   } catch (error) {
    if (isUniqueConstraintError(error)) throw conflict('An active request already exists for this origin');
    throw error;
   }
  },
  review: async (actor: Actor, id: string, action: 'approve' | 'reject' | 'revoke', reason: string, at: Date, blockedHosts: readonly string[] = []) => {
   staff(actor);
   return client.$transaction(async tx => {
    const initial = await tx.webglNetworkRequest.findUnique({ where: { id }, select: { projectId: true } });
    if (!initial) throw notFound();
    if (initial.projectId === null) throw conflict('The project no longer exists');
    // Shared lock source with session issuance; never lock play sessions here.
    await tx.$queryRaw`SELECT id FROM projects WHERE id = ${initial.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM webgl_network_requests WHERE id = ${id} FOR UPDATE`;
    const row = await tx.webglNetworkRequest.findUniqueOrThrow({ where: { id } });
    if (row.projectId === null) throw conflict('The project no longer exists');
    const expected = action === 'revoke' ? 'APPROVED' : 'PENDING';
    if (row.state !== expected) throw conflict(`Only ${expected.toLowerCase()} requests can be ${action}d`);
    if (action === 'approve') {
     if (!validateWebglNetworkOrigin(row.origin, row.mode) || blockedHosts.includes(new URL(row.origin).hostname)) throw forbidden('This origin cannot be approved');
     if (await tx.webglNetworkRequest.count({ where: { projectId: row.projectId, state: 'APPROVED' } }) >= 16) throw conflict('A project supports at most sixteen approved connection origins');
    }
    const project = await tx.project.findUniqueOrThrow({ where: { id: row.projectId } });
    const policyVersion = action === 'reject' ? null : project.webglNetworkPolicyVersion + 1;
    if (policyVersion !== null) await tx.project.update({ where: { id: project.id }, data: { webglNetworkPolicyVersion: policyVersion } });
    await tx.webglNetworkReviewEvent.create({ data: {
     requestId: id, originalProjectId: row.originalProjectId, origin: row.origin, action: action.toUpperCase(),
     actorId: actor.id, reason, policyVersion, createdAt: at,
    } });
    return present(await tx.webglNetworkRequest.update({ where: { id }, data: {
     state: action === 'approve' ? 'APPROVED' : action === 'reject' ? 'REJECTED' : 'REVOKED',
     reviewerId: actor.id, reviewReason: reason, reviewedAt: at, policyVersion,
     ...(action === 'revoke' ? { revokedAt: at } : {}),
    }, include: eventsInclude }));
   });
  },
 };
}
export type WebglNetworkRepository = ReturnType<typeof createWebglNetworkRepository>;
export function createUnavailableWebglNetworkRepository(): WebglNetworkRepository {
 const fail = async (): Promise<never> => { throw new Error('WebGL network policy persistence unavailable'); };
 return { listOwner: fail, listAdmin: fail, create: fail, review: fail };
}
