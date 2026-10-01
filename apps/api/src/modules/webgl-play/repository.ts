import { canReadProject } from "../../shared/visibility.js";
import { forbidden } from "../../shared/errors.js";
import type { PrismaClient, Prisma, WebglPlaySession } from "../../generated/prisma/client.js";
const projectInclude = { exhibition: true, members: true } as const;
async function assertPolicyValid(client: PrismaClient | Prisma.TransactionClient, play: WebglPlaySession, externalEnabled: boolean) {
 if (play.approvedOrigins.length === 0) return;
 if (!externalEnabled || await client.webglNetworkReviewEvent.count({ where: {
  originalProjectId: play.projectId, action: 'REVOKE', policyVersion: { gt: play.policyVersion },
  origin: { in: play.approvedOrigins },
 } })) throw forbidden('The external connection policy for this play session was revoked');
}
export function createWebglPlayRepository(client: PrismaClient) {
  return {
    session: async (id: string) =>
      client.authSession.findUnique({ where: { id }, include: { user: true } }),
    deployment: async (projectId: number) =>
      client.webglDeployment.findFirst({
        where: {
          projectId,
          state: "READY",
          currentForProject: { id: projectId },
        },
        include: { project: { include: projectInclude } },
      }),
    find: async (id: string) =>
      client.webglPlaySession.findUnique({ where: { id } }),
    findAsset: async (assetHash: string) =>
      client.webglPlaySession.findUnique({ where: { assetHash } }),
    // Serialize the global budget check with issuance, including anonymous sessions.
    createBounded: async (
      data: Prisma.WebglPlaySessionUncheckedCreateInput,
      at: Date,
      externalEnabled = false,
    ) =>
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(73489123)`;
        // Lock the FK parent before deleting expired children. Otherwise logout
        // can wait on a deleted child while issuance waits on its parent at INSERT.
        if (data.sessionId) {
          const sessions = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM auth_sessions WHERE id = ${data.sessionId} AND expires_at > ${at} FOR UPDATE`;
          if (!sessions.length) throw forbidden();
        }
        // Approval/revocation take the conflicting project UPDATE lock. Snapshot
        // selection and persistence therefore cannot straddle a policy change.
        await tx.$queryRaw`SELECT id FROM projects WHERE id = ${data.projectId} FOR SHARE`;
        const project = await tx.project.findUnique({ where: { id: data.projectId }, include: {
          ...projectInclude, currentWebglDeployment: true,
        } });
        const session = data.sessionId ? await tx.authSession.findUnique({ where: { id: data.sessionId }, include: { user: true } }) : null;
        if (!project || project.currentWebglDeploymentId !== data.deploymentId || project.currentWebglDeployment?.state !== 'READY'
          || (data.sessionId && (!session || session.expiresAt <= at)) || !canReadProject(session?.user ?? null, project)) throw forbidden();
        const approvedOrigins = externalEnabled ? (await tx.webglNetworkRequest.findMany({
          where: { projectId: data.projectId, state: 'APPROVED' }, select: { origin: true }, orderBy: { origin: 'asc' },
        })).map(grant => grant.origin) : [];
        await tx.webglPlaySession.deleteMany({
          where: { expiresAt: { lte: at } },
        });
        if (
          (await tx.webglPlaySession.count({ where: { revokedAt: null } })) >=
            4096 ||
          (await tx.webglPlaySession.count({
            where: { sessionId: data.sessionId ?? null, revokedAt: null },
          })) >= (data.sessionId ? 16 : 1024)
        )
          return null;
        return tx.webglPlaySession.create({ data: { ...data, approvedOrigins, policyVersion: project.webglNetworkPolicyVersion } });
      }),
    policyValid: async (play: WebglPlaySession, externalEnabled: boolean) => assertPolicyValid(client, play, externalEnabled),
    renewAuthorized: async (id: string, at: Date, idleMs: number, externalEnabled = false) =>
      client.$transaction(async (tx) => {
        // Logout locks the parent auth session before cascading to play leases.
        // Use the same order to avoid a renewal/logout deadlock.
        const identity = await tx.webglPlaySession.findUnique({ where: { id }, select: { sessionId: true } });
        if (!identity) throw forbidden();
        if (identity.sessionId)
          await tx.$executeRaw`SELECT id FROM auth_sessions WHERE id = ${identity.sessionId} FOR UPDATE`;
        await tx.$executeRaw`SELECT id FROM webgl_play_sessions WHERE id = ${id} FOR UPDATE`;
        const play = await tx.webglPlaySession.findUnique({ where: { id } });
        if (
          !play ||
          play.revokedAt ||
          play.expiresAt <= at ||
          play.absoluteExpiresAt <= at
        )
          throw forbidden();
        const session = play.sessionId
          ? await tx.authSession.findUnique({
              where: { id: play.sessionId },
              include: { user: true },
            })
          : null;
        if (
          play.sessionId &&
          (!session ||
            session.expiresAt <= at ||
            at.getTime() - session.lastSeenAt.getTime() >= idleMs)
        )
          throw forbidden();
        await tx.$executeRaw`SELECT id FROM projects WHERE id = ${play.projectId} FOR SHARE`;
        const dep = await tx.webglDeployment.findFirst({
          where: {
            id: play.deploymentId,
            state: "READY",
            currentForProject: { id: play.projectId },
          },
          include: { project: { include: projectInclude } },
        });
        if (!dep || !canReadProject(session?.user ?? null, dep.project))
          throw forbidden();
        await assertPolicyValid(tx, play, externalEnabled);
        const expiresAt = new Date(
          Math.min(
            at.getTime() + 15 * 60_000,
            play.absoluteExpiresAt.getTime(),
            session?.expiresAt.getTime() ?? Infinity,
          ),
        );
        await tx.webglPlaySession.update({
          where: { id },
          data: { expiresAt },
        });
        if (session)
          await tx.authSession.update({
            where: { id: session.id },
            data: { lastSeenAt: at },
          });
        return {
          expiresAt,
          absoluteExpiresAt: play.absoluteExpiresAt,
          session,
        };
      }),
    close: async (id: string, at: Date) =>
      client.webglPlaySession.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: at },
      }),
  };
}
export type WebglPlayRepository = ReturnType<typeof createWebglPlayRepository>;
export function createUnavailableWebglPlayRepository(): WebglPlayRepository {
  const fail = async (): Promise<never> => {
    throw new Error("WebGL play persistence unavailable");
  };
  return {
    session: fail,
    deployment: fail,
    find: fail,
    findAsset: fail,
    createBounded: fail,
    policyValid: fail,
    renewAuthorized: fail,
    close: fail,
  };
}
