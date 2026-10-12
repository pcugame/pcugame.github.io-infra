import type { PrismaClient } from '../../generated/prisma/client.js';
import { forbidden } from '../../shared/errors.js';
import type { DiagnosticRepository } from './diagnostic-ports.js';
import { canStoreDiagnostic, connectionRevocationFilter, nextReportWindow } from './policy.js';

export function createDiagnosticRepository(client: PrismaClient): DiagnosticRepository {
 return {
  async record(reportHash, item, at) {
   await client.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM webgl_play_sessions WHERE report_hash = ${reportHash} FOR UPDATE`;
    if (!rows[0]) throw forbidden();
    const session = await tx.webglPlaySession.findUniqueOrThrow({ where: { id: rows[0].id } });
    const revocationCount = session.approvedOrigins.length
      ? await tx.webglNetworkReviewEvent.count({ where: connectionRevocationFilter(session) }) : 0;
    const data = nextReportWindow(session, revocationCount, at);
    await tx.webglPlaySession.update({ where: { id: session.id }, data });
    if (!item) return;
    const key = { sessionId: session.id, ...item };
    const existing = await tx.webglConnectionDiagnostic.findUnique({ where: { sessionId_origin_directive: key } });
    const distinctCount = existing ? 0 : await tx.webglConnectionDiagnostic.count({ where: { sessionId: session.id } });
    if (!canStoreDiagnostic(existing !== null, distinctCount)) return;
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
export function createUnavailableDiagnosticRepository(): DiagnosticRepository {
 const fail = async (): Promise<never> => { throw new Error('WebGL diagnostics persistence unavailable'); };
 return { record: fail, list: fail };
}
