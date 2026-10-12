import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError, forbidden } from '../../shared/errors.js';

export function createDiagnosticRepository(client: PrismaClient) {
 return {
  async record(reportHash: string, item: { origin: string; directive: string } | null, at: Date) {
   await client.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM webgl_play_sessions WHERE report_hash = ${reportHash} FOR UPDATE`;
    if (!rows[0]) throw forbidden();
    const session = await tx.webglPlaySession.findUniqueOrThrow({ where: { id: rows[0].id } });
    if (session.revokedAt || session.expiresAt <= at || session.absoluteExpiresAt <= at) throw forbidden();
    if (session.approvedOrigins.length && await tx.webglNetworkReviewEvent.count({ where: {
     originalProjectId: session.projectId, action: 'REVOKE', policyVersion: { gt: session.policyVersion }, origin: { in: session.approvedOrigins },
    } })) throw forbidden();
    const inWindow = session.reportWindowAt && at.getTime() - session.reportWindowAt.getTime() < 60_000;
    if (inWindow && session.reportCount >= 30) throw new AppError(429, 'Report limit reached', 'RATE_LIMITED');
    await tx.webglPlaySession.update({ where: { id: session.id }, data: {
     reportWindowAt: inWindow ? session.reportWindowAt : at, reportCount: inWindow ? session.reportCount + 1 : 1,
    } });
    if (!item) return;
    const key = { sessionId: session.id, ...item };
    const existing = await tx.webglConnectionDiagnostic.findUnique({ where: { sessionId_origin_directive: key } });
    if (!existing && await tx.webglConnectionDiagnostic.count({ where: { sessionId: session.id } }) >= 20) return;
    await tx.webglConnectionDiagnostic.upsert({ where: { sessionId_origin_directive: key },
     create: { ...key, firstSeenAt: at, lastSeenAt: at }, update: { count: { increment: 1 }, lastSeenAt: at } });
   });
  },
  async list(sessionId: string) {
   return (await client.webglConnectionDiagnostic.findMany({ where: { sessionId }, orderBy: { firstSeenAt: 'asc' } }))
    .map(({ origin, directive, count, firstSeenAt, lastSeenAt }) => ({ origin, directive, count, firstSeenAt: firstSeenAt.toISOString(), lastSeenAt: lastSeenAt.toISOString() }));
  },
 };
}
export type DiagnosticRepository = ReturnType<typeof createDiagnosticRepository>;
