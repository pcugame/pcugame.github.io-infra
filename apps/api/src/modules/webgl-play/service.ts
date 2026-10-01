import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Env } from "../../config/env.js";
import { forbidden, notFound, AppError } from "../../shared/errors.js";
import { canReadProject } from "../../shared/visibility.js";
import { manifestIncludes } from "../file-access/service.js";
import type { WebglPlayRepository } from "./repository.js";
import { validateWebglNetworkOrigin } from '@pcu/contracts';
import { isPrivilegedNetworkOrigin } from '../webgl-network/service.js';
const IDLE = 15 * 60_000;
const MAX = 8 * 60 * 60_000;
const hash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
export function runtimeCsp(
  origin: string,
  token: string,
  apiUrl: string,
  approvedOrigins: readonly string[] = [],
): string {
  const path = `${origin}/runtime/${token}/`;
  const connections = approvedOrigins.length ? ` ${approvedOrigins.join(' ')}` : '';
  return `default-src 'none'; script-src ${path} blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src ${path} blob:; connect-src ${path} blob:${connections}; img-src ${path} data: blob:; media-src ${path} blob:; style-src ${path} 'unsafe-inline'; font-src ${path} data:; frame-ancestors ${new URL(apiUrl).origin}; base-uri 'none'; form-action 'none'; object-src 'none'`;
}
export function createWebglPlayService(
  repository: WebglPlayRepository,
  config: Env,
  now = () => new Date(),
) {
  function enabled() {
    if (
      !config.WEBGL_PLAY_ENABLED ||
      !config.PUBLIC_ASSET_ORIGIN ||
      config.PUBLIC_ASSET_ORIGIN === new URL(config.API_PUBLIC_URL).origin
    )
      throw notFound();
  }
  async function login(sid?: string | null) {
    if (!sid) return null;
    const session = await repository.session(sid);
    const at = now();
    if (
      !session ||
      session.expiresAt <= at ||
      at.getTime() - session.lastSeenAt.getTime() >= config.SESSION_IDLE_MS
    )
      throw forbidden();
    return session;
  }
  async function deployment(projectId: number, sid?: string | null) {
    const session = await login(sid);
    const dep = await repository.deployment(projectId);
    if (
      !dep ||
      !canReadProject(session?.user ?? null, dep.project) ||
      !manifestIncludes(dep.objectManifest, dep.entryObjectKey) ||
      dep.publicBucket !== config.S3_BUCKET_PUBLIC ||
      !dep.entryObjectKey.startsWith(dep.publicPrefix.replace(/\/$/, "") + "/")
    )
      throw forbidden();
    return { dep, session };
  }
  async function control(id: string, secret: unknown, sid?: string) {
    enabled();
    if (typeof secret !== "string" || !/^[a-f0-9]{64}$/.test(secret))
      throw forbidden();
    const play = await repository.find(id);
    if (
      !play ||
      play.controlHash !== hash(secret) ||
      (play.sessionId && play.sessionId !== sid)
    )
      throw forbidden();
    await login(play.sessionId);
    return play;
  }
  async function checkPolicy(play: NonNullable<Awaited<ReturnType<WebglPlayRepository['find']>>>) {
    if (!config.WEBGL_EXTERNAL_CONNECTIONS_ENABLED && play.approvedOrigins.length) {
      // Commit revocation separately: throwing inside renewal's transaction would
      // roll it back and allow the session to revive when the flag is reenabled.
      await repository.close(play.id, now());
      throw forbidden('External connections are disabled for this play session');
    }
    await repository.policyValid(play, config.WEBGL_EXTERNAL_CONNECTIONS_ENABLED);
  }
  return {
    async create(projectId: number, sid?: string) {
      enabled();
      const { dep, session } = await deployment(projectId, sid);
      const at = now();
      const absoluteExpiresAt = new Date(
        Math.min(at.getTime() + MAX, session?.expiresAt.getTime() ?? Infinity),
      );
      const expiresAt = new Date(
        Math.min(at.getTime() + IDLE, absoluteExpiresAt.getTime()),
      );
      const controlSecret = randomBytes(32).toString("hex"),
        assetToken = randomBytes(32).toString("hex");
      const play = await repository.createBounded(
        {
          id: randomUUID(),
          controlHash: hash(controlSecret),
          assetHash: hash(assetToken),
          sessionId: sid ?? null,
          projectId,
          deploymentId: dep.id,
          expiresAt,
          absoluteExpiresAt,
        },
        at,
        config.WEBGL_EXTERNAL_CONNECTIONS_ENABLED,
      );
      if (!play)
        throw new AppError(429, "Too many play sessions", "RATE_LIMITED");
      const entry = dep.entryObjectKey
        .slice(dep.publicPrefix.replace(/\/$/, "").length + 1)
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      return {
        id: play.id,
        controlSecret,
        iframeUrl: `${config.PUBLIC_ASSET_ORIGIN}/runtime/${assetToken}/${entry}`,
        projectTitle: dep.project.title,
        expiresAt: expiresAt.toISOString(),
        absoluteExpiresAt: absoluteExpiresAt.toISOString(),
      };
    },
    async renew(id: string, secret: unknown, sid?: string, visible = true) {
      const play = await control(id, secret, sid),
        at = now();
      if (
        !visible ||
        play.revokedAt ||
        play.expiresAt <= at ||
        play.absoluteExpiresAt <= at
      )
        throw forbidden();
      await checkPolicy(play);
      const result = await repository.renewAuthorized(
        id,
        at,
        config.SESSION_IDLE_MS,
        config.WEBGL_EXTERNAL_CONNECTIONS_ENABLED,
      );
      return {
        data: {
          expiresAt: result.expiresAt.toISOString(),
          absoluteExpiresAt: result.absoluteExpiresAt.toISOString(),
        },
        session: result.session,
      };
    },
    async close(id: string, secret: unknown, sid?: string) {
      await control(id, secret, sid);
      await repository.close(id, now());
    },
    async resolveRuntime(
      raw: string,
      headers: Record<string, string | string[] | undefined>,
    ) {
      enabled();
      if (
        !["GET", "HEAD"].includes(String(headers["x-pcu-file-method"])) ||
        headers["x-pcu-service-worker"] ||
        headers["x-pcu-fetch-dest"] === "serviceworker"
      )
        throw forbidden();
      // Validate raw segments before URL parsing can normalize traversal. Reject nested escapes.
      const match = /^\/runtime\/([a-f0-9]{64})\/([^?#]+)(?:\?[^#]*)?$/.exec(
        raw,
      );
      if (!match) throw forbidden();
      let relative: string;
      try {
        relative = decodeURIComponent(match[2]!);
      } catch {
        throw forbidden();
      }
      if (
        /[\\\u0000-\u001f\u007f?#]/.test(relative) ||
        relative.split("/").some((s) => !s || s === "." || s === "..")
      )
        throw forbidden();
      const play = await repository.findAsset(hash(match[1]!)),
        at = now();
      if (
        !play ||
        play.revokedAt ||
        play.expiresAt <= at ||
        play.absoluteExpiresAt <= at
      )
        throw forbidden();
      const { dep } = await deployment(play.projectId, play.sessionId);
      if (dep.id !== play.deploymentId) throw forbidden();
      await checkPolicy(play);
      if (play.approvedOrigins.some(origin => !validateWebglNetworkOrigin(origin, origin.startsWith('wss:') ? 'WSS' : 'HTTPS')
        || isPrivilegedNetworkOrigin(origin, config))) throw forbidden();
      const key = dep.publicPrefix.replace(/\/$/, "") + "/" + relative;
      if (!manifestIncludes(dep.objectManifest, key)) throw forbidden();
      return {
        path: "/" + key.split("/").map(encodeURIComponent).join("/"),
        host: "",
        csp: runtimeCsp(
          config.PUBLIC_ASSET_ORIGIN!,
          match[1]!,
          config.API_PUBLIC_URL,
          play.approvedOrigins,
        ),
      };
    },
  };
}
export type WebglPlayService = ReturnType<typeof createWebglPlayService>;
