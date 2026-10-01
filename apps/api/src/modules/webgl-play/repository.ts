import { canReadProject } from "../../shared/visibility.js";
import { forbidden } from "../../shared/errors.js";
import type { PrismaClient, Prisma } from "../../generated/prisma/client.js";
const projectInclude = { exhibition: true, members: true } as const;
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
    ) =>
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(73489123)`;
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
        return tx.webglPlaySession.create({ data });
      }),
    renewAuthorized: async (id: string, at: Date, idleMs: number) =>
      client.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM webgl_play_sessions WHERE id = ${id} FOR UPDATE`;
        const play = await tx.webglPlaySession.findUnique({ where: { id } });
        if (
          !play ||
          play.revokedAt ||
          play.expiresAt <= at ||
          play.absoluteExpiresAt <= at
        )
          throw forbidden();
        if (play.sessionId)
          await tx.$executeRaw`SELECT id FROM auth_sessions WHERE id = ${play.sessionId} FOR UPDATE`;
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
    renewAuthorized: fail,
    close: fail,
  };
}
