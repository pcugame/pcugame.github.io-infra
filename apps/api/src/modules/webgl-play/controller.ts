import type { FastifyPluginAsync } from "fastify";
import type { Env } from "../../config/env.js";
import { forbidden, notFound } from "../../shared/errors.js";
import { cookieExpiresAt } from "../../shared/session.js";
import type { WebglPlayService } from "./service.js";
import { isTrustedPlaySource } from "./source.js";
import { renderPlayShell, playShellHeaders } from "./runtime-ui.js";
export function createWebglPlayController(
  service: WebglPlayService,
  config: Env,
  now = () => new Date(),
): FastifyPluginAsync {
  return async (app) => {
    app.addHook("onRequest", async (request, reply) => {
      reply
        .header("Cache-Control", "private, no-store")
        .header("Referrer-Policy", "no-referrer");
      if (!config.WEBGL_PLAY_ENABLED) throw notFound();
      if (
        request.method === "POST" &&
        !isTrustedPlaySource(request.headers, config.API_PUBLIC_URL)
      )
        throw forbidden();
    });
    app.get<{ Params: { projectId: number } }>(
      "/play/projects/:projectId",
      async (request, reply) => {
        for (const [key, value] of Object.entries(playShellHeaders(config)))
          reply.header(key, value);
        return reply
          .type("text/html; charset=utf-8")
          .send(renderPlayShell(config, request.params.projectId));
      },
    );
    app.post<{ Body: { projectId: number } }>(
      "/api/webgl-play/sessions",
      { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
      async (request) => ({
        ok: true,
        data: await service.create(
          request.body.projectId,
          request.cookies[config.SESSION_COOKIE_NAME],
        ),
      }),
    );
    app.post<{ Params: { id: string }; Body?: { visible?: boolean } }>(
      "/api/webgl-play/sessions/:id/renew",
      async (request, reply) => {
        const result = await service.renew(
          request.params.id,
          request.headers["x-pcu-play-control"],
          request.cookies[config.SESSION_COOKIE_NAME],
          request.body?.visible ?? true,
        );
        if (result.session)
          reply.setCookie(config.SESSION_COOKIE_NAME, result.session.id, {
            httpOnly: true,
            secure: config.COOKIE_SECURE,
            sameSite: config.COOKIE_SAME_SITE,
            path: "/",
            expires: cookieExpiresAt(
              result.session,
              now(),
              config.SESSION_IDLE_MS,
            ),
          });
        return { ok: true, data: result.data };
      },
    );
    app.post<{ Params: { id: string } }>(
      "/api/webgl-play/sessions/:id/close",
      async (request) => {
        await service.close(
          request.params.id,
          request.headers["x-pcu-play-control"],
          request.cookies[config.SESSION_COOKIE_NAME],
        );
        return { ok: true, data: { closed: true } };
      },
    );
  };
}
