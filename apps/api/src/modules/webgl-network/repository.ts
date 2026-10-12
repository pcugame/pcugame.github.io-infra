import { AllowWebglNetworkBatchSchema, ConnectionRule, CreateWebglNetworkBatchSchema, ProjectConnectionPolicy, validateWebglNetworkOrigin, type CreateWebglNetworkRequest, type WebglNetworkRequest } from '@pcu/contracts';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Actor } from '../../application/http-input.js';
import { AppError, badRequest, conflict, forbidden, notFound, isUniqueConstraintError } from '../../shared/errors.js';
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
 async function createBatch(actor: Actor, projectId: number, body: unknown, blockedHosts: readonly string[] = [], directAt?: Date) {
  if (directAt) staff(actor);
  let writingIndex = 0;
  try {
   return await client.$transaction(async tx => {
    const project = await assertProjectWriteAccessInTransaction(tx, actor, projectId);
    const related = project.creatorId === actor.id || await tx.projectMember.findFirst({ where: { projectId, userId: actor.id } });
    if (!directAt && !related) throw forbidden('Only the creator or linked members may request connections');
    if (!directAt && project.isModificationEnabled === false) throw forbidden('Project modifications are closed for this exhibition');
    const parsed = (directAt ? AllowWebglNetworkBatchSchema : CreateWebglNetworkBatchSchema).safeParse(body);
    if (!parsed.success) throw badRequest('연결 입력을 확인하세요.', 'VALIDATION_ERROR', parsed.error.issues.map(issue => ({
     index: typeof issue.path[1] === 'number' ? issue.path[1] : null, field: String(issue.path[2] ?? issue.path[0] ?? 'items'), message: issue.message,
    })));
    const active = await tx.webglNetworkRequest.findMany({ where: { projectId, state: { in: ['PENDING', 'APPROVED'] } }, select: { origin: true, state: true } });
    const errors = parsed.data.items.flatMap((input, index) => {
     if (blockedHosts.some(host => ConnectionRule.parse(input.origin).includesHostname(host))) return [{ index, field: 'origin', message: '사이트·스토리지 보호 호스트는 신청할 수 없습니다.', conflict: false }];
     if (active.some(row => row.origin === input.origin)) return [{ index, field: 'origin', message: '이미 대기 중이거나 승인된 주소입니다.', conflict: true }];
     return [];
    });
    if (errors.length) throw new AppError(errors.some(error => !error.conflict) ? 400 : 409, '연결 입력을 확인하세요.', errors.some(error => !error.conflict) ? 'VALIDATION_ERROR' : 'CONFLICT', errors);
    if (directAt) {
     const approved = active.filter(row => row.state === 'APPROVED');
     const overlap = parsed.data.items.flatMap((input, index) => approved.some(row => ConnectionRule.parse(row.origin).overlaps(ConnectionRule.parse(input.origin)))
      ? [{ index, field: 'origin', message: '이미 승인된 연결 범위와 겹칩니다. 기존 승인을 확인하세요.' }] : []);
     if (overlap.length) throw new AppError(409, '이미 승인된 연결 범위와 겹칩니다.', 'CONFLICT', overlap);
     if (approved.length + parsed.data.items.length > 16) throw conflict('작품당 최대 16개 연결을 허용할 수 있습니다.');
     new ProjectConnectionPolicy([...approved.map(row => row.origin), ...parsed.data.items.map(row => row.origin)], blockedHosts);
    }
    const source = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { title: true, webglNetworkPolicyVersion: true } });
    const reason = directAt ? AllowWebglNetworkBatchSchema.parse(body).reason : null;
    const rows: WebglNetworkRequest[] = [];
    for (const [index, input] of parsed.data.items.entries()) {
     writingIndex = index;
     rows.push(present(await tx.webglNetworkRequest.create({ data: {
      ...input, projectId, originalProjectId: projectId, projectTitle: source.title, requesterId: actor.id,
      ...(directAt ? {
       state: 'APPROVED' as const, reviewerId: actor.id, reviewReason: reason, reviewedAt: directAt,
       policyVersion: source.webglNetworkPolicyVersion + index + 1,
       events: { create: { originalProjectId: projectId, origin: input.origin, action: 'APPROVE', actorId: actor.id,
        reason: reason!, policyVersion: source.webglNetworkPolicyVersion + index + 1, createdAt: directAt } },
      } : {}),
     }, include: eventsInclude })));
    }
    if (directAt) await tx.project.update({ where: { id: projectId }, data: { webglNetworkPolicyVersion: source.webglNetworkPolicyVersion + rows.length } });
    return rows;
   });
  } catch (error) {
   if (isUniqueConstraintError(error)) throw new AppError(409, 'An active request already exists for this origin', 'CONFLICT', [{ index: writingIndex, field: 'origin', message: '이미 대기 중이거나 승인된 주소입니다.' }]);
   throw error;
  }
 }
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
  create: async (actor: Actor, projectId: number, input: CreateWebglNetworkRequest) => (await createBatch(actor, projectId, { items: [input] }))[0]!,
  createBatch,
  allowBatch: (actor: Actor, projectId: number, body: unknown, blockedHosts: readonly string[], at: Date) => createBatch(actor, projectId, body, blockedHosts, at),
  listProjectAdmin: async (actor: Actor, projectId: number) => {
   staff(actor);
   return client.$transaction(async tx => {
    const project = await tx.project.findUnique({ where: { id: projectId }, include: { changeRequestDraft: true } });
    if (!project || project.changeRequestDraft) throw notFound();
    const rows = await tx.webglNetworkRequest.findMany({ where: { projectId }, include: eventsInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
    return { items: rows.map(present), policyVersion: project.webglNetworkPolicyVersion };
   });
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
     if (!validateWebglNetworkOrigin(row.origin, row.mode)) throw forbidden('This origin cannot be approved');
     const approved = await tx.webglNetworkRequest.findMany({ where: { projectId: row.projectId, state: 'APPROVED' }, select: { origin: true } });
     try { new ProjectConnectionPolicy([...approved.map(item => item.origin), row.origin], blockedHosts); }
     catch { throw conflict('Connection rules overlap, exceed sixteen rules, or include a protected host'); }
    }
    const project = await tx.project.findUniqueOrThrow({ where: { id: row.projectId } });
    const policyVersion = project.webglNetworkPolicyVersion + (action === 'reject' ? 0 : 1);
    if (action !== 'reject') await tx.project.update({ where: { id: project.id }, data: { webglNetworkPolicyVersion: policyVersion } });
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
 return { listOwner: fail, listAdmin: fail, create: fail, createBatch: fail, allowBatch: fail, listProjectAdmin: fail, review: fail };
}
