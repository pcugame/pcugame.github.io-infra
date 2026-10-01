import { createHash } from 'node:crypto';
import { WebglPlayCreateDataSchema } from '@pcu/contracts';
import { createWebglPlayRepository } from "../modules/webgl-play/repository.js";
import { createWebglPlayService } from "../modules/webgl-play/service.js";
import { createWebglPlayController } from "../modules/webgl-play/controller.js";
import { registerCsrf } from "../plugins/csrf.js";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import {
  serializerCompiler,
  validatorCompiler,
} from "@fastify/type-provider-zod";
import { registerRouteSchemas } from "../shared/http-route-schemas.js";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createIsolatedMigratedDatabase } from "./helpers/isolated-migrated-database.js";
import { createFileAccessController } from "../modules/file-access/controller.js";
import { createFileAccessRepository } from "../modules/file-access/repository.js";
import { registerAuth } from "../plugins/auth.js";
import { AppError } from "../shared/errors.js";
import type { Env } from "../config/env.js";

describe.runIf(process.env["RUN_POSTGRES_INTEGRATION"] === "true")(
  "trusted play authenticated HTTP boundary",
  () => {
    let db: PrismaClient,
      app: FastifyInstance,
      database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
    let owner: number,
      stranger: number,
      sid: string,
      projectId: number,
      deploymentId: string;
    let time = new Date();
    const secret = "file-access-integration-secret-32chars";
    const origin = "http://localhost:5173";
    const key = "public/images/test/image %.png";
    beforeAll(async () => {
      database = await createIsolatedMigratedDatabase(
        process.env["DATABASE_URL"]!,
      );
      db = database.createClient();
      const a = await db.user.create({
        data: {
          googleSub: randomUUID(),
          email: randomUUID() + "@test.invalid",
        },
      });
      owner = a.id;
      const b = await db.user.create({
        data: {
          googleSub: randomUUID(),
          email: randomUUID() + "@test.invalid",
        },
      });
      stranger = b.id;
      sid = (
        await db.authSession.create({
          data: {
            userId: owner,
            expiresAt: new Date(time.getTime() + 3600000),
          },
        })
      ).id;
      await db.storageBucket.createMany({
        data: [
          { bucket: "public", visibility: "PUBLIC" },
          { bucket: "protected", visibility: "PROTECTED" },
        ],
      });
      const ex = await db.exhibition.create({
        data: { year: 2098, title: randomUUID(), visibility: "STAFF" },
      });
      const project = await db.project.create({
        data: {
          exhibitionId: ex.id,
          creatorId: owner,
          slug: randomUUID(),
          title: "Restricted",
          status: "PUBLISHED",
          visibility: "AUTHENTICATED",
        },
      });
      projectId = project.id;
      await db.asset.create({
        data: {
          projectId,
          kind: "IMAGE",
          representations: {
            create: [
              {
                role: "ORIGINAL",
                bucket: "public",
                objectKey: key,
                state: "READY",
                mimeType: "image/png",
              },
              {
                role: "CARD_480",
                bucket: "public",
                objectKey: key + "-card",
                state: "READY",
                mimeType: "image/webp",
              },
              {
                role: "DISPLAY_960",
                bucket: "public",
                objectKey: key + "-display",
                state: "READY",
                mimeType: "image/webp",
              },
            ],
          },
        },
      });
      await db.asset.create({
        data: {
          projectId,
          kind: "VIDEO",
          representations: {
            create: [
              {
                role: "ORIGINAL",
                bucket: "protected",
                objectKey: "video-original.mp4",
                state: "READY",
                mimeType: "video/mp4",
              },
              {
                role: "PLAYBACK",
                bucket: "protected",
                objectKey: "video.mp4",
                state: "READY",
                mimeType: "video/mp4",
              },
            ],
          },
        },
      });
      const source = await db.asset.create({
        data: {
          projectId,
          kind: "WEBGL",
          representations: {
            create: {
              role: "WEBGL_SOURCE",
              bucket: "protected",
              objectKey: "source.zip",
              state: "READY",
              mimeType: "application/octet-stream",
            },
          },
        },
        include: { representations: true },
      });
      deploymentId = randomUUID();
      const prefix = `public/webgl/${projectId}/${deploymentId}/`;
      await db.webglDeployment.create({
        data: {
          id: deploymentId,
          projectId,
          sourceRepresentationId: source.representations[0]!.id,
          publicBucket: "public",
          publicPrefix: prefix,
          entryObjectKey: prefix + "index.html",
          state: "READY",
          objectManifest: {
            version: 1,
            objects: [
              {
                objectKey: prefix + "index.html",
                sizeBytes: "1",
                mimeType: "text/html",
              },
              {
                objectKey: prefix + "Build/game.wasm",
                sizeBytes: "1",
                mimeType: "application/wasm",
              },
              {
                objectKey: prefix + "Build/100%.wasm",
                sizeBytes: "1",
                mimeType: "application/wasm",
              },
              {
                objectKey: prefix + "Build/My Game.framework.js",
                sizeBytes: "1",
                mimeType: "application/javascript",
              },
            ],
          },
        },
      });
      await db.project.update({
        where: { id: projectId },
        data: { currentWebglDeploymentId: deploymentId },
      });
      const config = {
        WEBGL_PLAY_ENABLED: true,
        CORS_ALLOWED_ORIGINS: [origin],
        COOKIE_SECURE: false,
        COOKIE_SAME_SITE: "lax",
        API_PUBLIC_URL: "http://api.test",
        WEB_PUBLIC_URL: origin,
        PUBLIC_ASSET_ORIGIN: "http://files.test",
        S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT: "http://protected.test",
        S3_BUCKET_PUBLIC: "public",
        S3_BUCKET_PROTECTED: "protected",
        SESSION_COOKIE_NAME: "sid",
        SESSION_IDLE_MS: 3600000,
        FILE_GATEWAY_SECRET: secret,
      } as Env;
      app = Fastify();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      await app.register(cookie);
      await registerAuth(app, {
        config: {
          ...config,
          SESSION_TOUCH_MIN_INTERVAL_MS: 0,
          COOKIE_SECURE: false,
          COOKIE_SAME_SITE: "lax",
          CORS_ALLOWED_ORIGINS: [origin],
        },
        clock: { now: () => time },
        logger: app.log,
        sessions: {
          find: (id) =>
            db.authSession.findUnique({
              where: { id },
              include: { user: true },
            }),
          touch: async (id, at) => {
            await db.authSession.update({
              where: { id },
              data: { lastSeenAt: at },
            });
          },
          delete: async (id) => {
            await db.authSession.delete({ where: { id } });
          },
        },
      });
      app.setErrorHandler((error, _request, reply) =>
        reply.status(error instanceof AppError ? error.statusCode : 500).send({
          ok: false,
          error: {
            code: error instanceof AppError ? error.code : "INTERNAL_ERROR",
            message: error instanceof Error ? error.message : "Unknown error",
          },
        }),
      );
      registerRouteSchemas(app);
      await registerCsrf(app, config);
      const service = createWebglPlayService(
        createWebglPlayRepository(db),
        config,
        () => time,
      );
      await app.register(
        createWebglPlayController(service, config, () => time),
      );
      await app.register(
        createFileAccessController(
          createFileAccessRepository(db),
          config,
          () => time,
          async (bucket, key) =>
            `http://protected.test/${bucket}/${key}?signedAt=${time.getTime()}`,
          undefined,
          service.resolveRuntime,
        ),
        { prefix: "/api" },
      );
    });
    afterAll(async () => {
      await app?.close();
      await database?.close();
    });
    const headers = {
      origin: "http://api.test",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "content-type": "application/json",
    };
    const issue = () =>
      app.inject({
        method: "POST",
        url: "/api/webgl-play/sessions",
        headers: { ...headers, cookie: "sid=" + sid },
        payload: { projectId },
      });
    const gate = (url: string, extra: Record<string, string> = {}) =>
      app.inject({
        url: "/api/internal/file-access",
        headers: {
          "x-pcu-gateway-secret": secret,
          "x-pcu-file-kind": "public",
          "x-pcu-file-uri": new URL(url).pathname,
          "x-pcu-file-method": "GET",
          ...extra,
        },
      });
    const control = (
      g: { id: string; controlSecret: string },
      action = "renew",
      credential = g.controlSecret,
      visible = true,
    ) =>
      app.inject({
        method: "POST",
        url: `/api/webgl-play/sessions/${g.id}/${action}`,
        headers: {
          ...headers,
          cookie: "sid=" + sid,
          "x-pcu-play-control": credential,
        },
        payload: action === "close" ? {} : { visible },
      });
    it("passes configured and cleared display sizes through authenticated session serialization", async () => {
      for (const settings of [
        { webglDisplayWidth: 1280, webglDisplayHeight: 720 },
        { webglDisplayWidth: null, webglDisplayHeight: null },
      ]) {
        await db.project.update({ where: { id: projectId }, data: settings });
        const response = await issue();
        expect(response.statusCode, response.body).toBe(200);
        const grant = WebglPlayCreateDataSchema.parse(response.json().data);
        expect(grant).toMatchObject(settings);
        expect((await control(grant, "close")).statusCode).toBe(200);
      }
    });
    it("serves the sized shell with matching CSP hashes and isolation headers", async () => {
      const response = await app.inject({ url: `/play/projects/${projectId}` });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain('id="fullscreen"');
      expect(response.body).toContain('configured-display');
      for (const tag of ["script", "style"]) {
        const text = response.body.match(new RegExp("<" + tag + ">([\\s\\S]*)</" + tag + ">"))![1]!;
        expect(response.headers["content-security-policy"]).toContain("'sha256-" + createHash("sha256").update(text).digest("base64") + "'");
      }
      expect(response.headers["content-security-policy"]).not.toContain("unsafe-inline");
      expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
      expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
    });
    it("issues separated hash-only credentials through authenticated serialized HTTP", async () => {
      const response = await issue();
      expect(response.statusCode, response.body).toBe(200);
      const g = response.json().data;
      expect(g.projectTitle).toBe("Restricted");
      expect(g.iframeUrl).toContain("/runtime/");
      const row = await db.webglPlaySession.findUniqueOrThrow({
        where: { id: g.id },
      });
      expect(row.controlHash).not.toBe(g.controlSecret);
      expect(row.assetHash).not.toBe(
        new URL(g.iframeUrl).pathname.split("/")[2],
      );
      expect((await gate(g.iframeUrl)).statusCode).toBe(204);
      expect(
        (
          await gate(
            g.iframeUrl.replace("index.html", "Build/My%20Game.framework.js"),
          )
        ).statusCode,
      ).toBe(204);
      expect(
        (await gate(g.iframeUrl.replace("index.html", "Build/100%25.wasm")))
          .statusCode,
      ).toBe(204);
      expect((await gate(g.iframeUrl)).headers["x-pcu-runtime-csp"]).toContain(
        "frame-ancestors http://api.test",
      );
      expect(
        (await gate(g.iframeUrl, { "x-pcu-file-method": "HEAD" })).statusCode,
      ).toBe(204);
      for (const method of ["POST", "PUT", ""])
        expect(
          (await gate(g.iframeUrl, { "x-pcu-file-method": method })).statusCode,
        ).toBe(403);
      expect(
        (await gate(g.iframeUrl, { "x-pcu-service-worker": "script" }))
          .statusCode,
      ).toBe(403);
      for (const path of ["%252e%252e/index.html", "unknown.wasm"])
        expect(
          (await gate(g.iframeUrl.replace("index.html", path))).statusCode,
        ).toBe(403);
      expect(
        (
          await control(
            g,
            "renew",
            new URL(g.iframeUrl).pathname.split("/")[2]!,
          )
        ).statusCode,
      ).toBe(403);
      for (const extra of [
        { origin: "null" },
        { origin: "http://files.test" },
        { "sec-fetch-site": "same-site" },
        { "sec-fetch-mode": "navigate" },
      ])
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/api/webgl-play/sessions",
              headers: { ...headers, ...extra, cookie: "sid=" + sid },
              payload: { projectId },
            })
          ).statusCode,
        ).toBe(403);
    });
    it("only validated visible renewals touch login and expired leases cannot revive", async () => {
      const g = (await issue()).json().data;
      const before = (
        await db.authSession.findUniqueOrThrow({ where: { id: sid } })
      ).lastSeenAt;
      time = new Date(time.getTime() + 60000);
      await gate(g.iframeUrl);
      await control(g, "renew", "a".repeat(64));
      await control(g, "renew", g.controlSecret, false);
      expect(
        (await db.authSession.findUniqueOrThrow({ where: { id: sid } }))
          .lastSeenAt,
      ).toEqual(before);
      const renewed = await control(g);
      expect(renewed.statusCode, renewed.body).toBe(200);
      expect(renewed.headers["set-cookie"]).toBeTruthy();
      expect(
        (await db.authSession.findUniqueOrThrow({ where: { id: sid } }))
          .lastSeenAt,
      ).toEqual(time);
      time = new Date(time.getTime() + 15 * 60000);
      expect((await control(g)).statusCode).toBe(403);
    });
    it("bounds leases by login absolute expiry and rejects raw traversal", async () => {
      const session = await db.authSession.findUniqueOrThrow({
        where: { id: sid },
      });
      await db.authSession.update({
        where: { id: sid },
        data: { expiresAt: new Date(time.getTime() + 5000) },
      });
      const g = (await issue()).json().data;
      expect(g.expiresAt).toBe(new Date(time.getTime() + 5000).toISOString());
      expect(g.absoluteExpiresAt).toBe(g.expiresAt);
      const prefix = new URL(g.iframeUrl).pathname.replace("index.html", "");
      for (const relative of [
        "../index.html",
        "%2e%2e/index.html",
        "Build%2f..%2findex.html",
        "%5cindex.html",
      ])
        expect(
          (
            await app.inject({
              url: "/api/internal/file-access",
              headers: {
                "x-pcu-gateway-secret": secret,
                "x-pcu-file-kind": "public",
                "x-pcu-file-method": "GET",
                "x-pcu-file-uri": prefix + relative,
              },
            })
          ).statusCode,
        ).toBe(403);
      await db.authSession.update({
        where: { id: sid },
        data: { expiresAt: session.expiresAt },
      });
    });
    it("allows anonymous public play bounded to eight hours; deletion revokes it", async () => {
      const original = await db.project.findUniqueOrThrow({
        where: { id: projectId },
        include: { exhibition: true },
      });
      await db.exhibition.update({
        where: { id: original.exhibitionId },
        data: { visibility: "PUBLIC" },
      });
      await db.project.update({
        where: { id: projectId },
        data: { visibility: "PUBLIC" },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/webgl-play/sessions",
        headers,
        payload: { projectId },
      });
      expect(response.statusCode, response.body).toBe(200);
      const g = response.json().data;
      expect(g.absoluteExpiresAt).toBe(
        new Date(time.getTime() + 8 * 3600000).toISOString(),
      );
      expect((await gate(g.iframeUrl)).statusCode).toBe(204);
      const dep = await db.webglDeployment.findUniqueOrThrow({
        where: { id: deploymentId },
      });
      await db.webglDeployment.delete({ where: { id: deploymentId } });
      expect((await gate(g.iframeUrl)).statusCode).toBe(403);
      await db.webglDeployment.create({
        data: {
          ...dep,
          objectManifest:
            dep.objectManifest as import("../generated/prisma/client.js").Prisma.InputJsonValue,
          stagingObjectManifest: undefined,
        },
      });
      await db.project.update({
        where: { id: projectId },
        data: {
          currentWebglDeploymentId: deploymentId,
          visibility: original.visibility,
        },
      });
      await db.exhibition.update({
        where: { id: original.exhibitionId },
        data: { visibility: original.exhibition.visibility },
      });
    });
    it("serializes close before renewal without touching login", async () => {
      const grant = (await issue()).json().data;
      const before = (
        await db.authSession.findUniqueOrThrow({ where: { id: sid } })
      ).lastSeenAt;
      time = new Date(time.getTime() + 1000);
      let locked!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const closing = db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM webgl_play_sessions WHERE id = ${grant.id} FOR UPDATE`;
        await tx.webglPlaySession.update({
          where: { id: grant.id },
          data: { revokedAt: time },
        });
        locked();
        await barrier;
      });
      await ready;
      const renewal = control(grant);
      release();
      await closing;
      expect((await renewal).statusCode).toBe(403);
      expect(
        (await db.authSession.findUniqueOrThrow({ where: { id: sid } }))
          .lastSeenAt,
      ).toEqual(before);
    });
    it("serializes logout cascade before renewal without a lock inversion", async () => {
      const logoutSid = (await db.authSession.create({ data: { userId: owner, expiresAt: new Date(time.getTime() + 3600000), lastSeenAt: time } })).id;
      const response = await app.inject({ method: 'POST', url: '/api/webgl-play/sessions', headers: { ...headers, cookie: 'sid=' + logoutSid }, payload: { projectId } });
      expect(response.statusCode).toBe(200);
      const grant = response.json().data;
      let locked!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const logout = db.$transaction(async tx => {
        await tx.$executeRaw`SELECT id FROM auth_sessions WHERE id = ${logoutSid} FOR UPDATE`;
        locked(); await barrier;
        await tx.authSession.delete({ where: { id: logoutSid } });
      }, { timeout: 10000 });
      await ready;
      const renewal = app.inject({ method: 'POST', url: `/api/webgl-play/sessions/${grant.id}/renew`, headers: { ...headers, cookie: 'sid=' + logoutSid, 'x-pcu-play-control': grant.controlSecret }, payload: { visible: true } });
      try {
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (Date.now() < deadline) {
          const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%auth_sessions%' AND query LIKE '%FOR UPDATE%') AS waiting`;
          if (rows[0]?.waiting) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
      } finally { release(); }
      await logout;
      expect((await renewal).statusCode).toBe(403);
      expect(await db.webglPlaySession.findUnique({ where: { id: grant.id } })).toBeNull();
    });
    it("serializes issuance cleanup with logout before inserting a new FK child", async () => {
      const logoutSid = (await db.authSession.create({ data: { userId: owner, expiresAt: new Date(time.getTime() + 3600000), lastSeenAt: time } })).id;
      const create = () => app.inject({ method: 'POST', url: '/api/webgl-play/sessions', headers: { ...headers, cookie: 'sid=' + logoutSid }, payload: { projectId } });
      const existing = await create(); expect(existing.statusCode).toBe(200);
      await db.webglPlaySession.update({ where: { id: existing.json().data.id }, data: { expiresAt: new Date(time.getTime() - 1) } });
      let locked!: () => void, release!: () => void;
      const ready = new Promise<void>(resolve => { locked = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const logout = db.$transaction(async tx => {
        await tx.$executeRaw`SELECT id FROM auth_sessions WHERE id = ${logoutSid} FOR UPDATE`;
        locked(); await barrier;
        await tx.authSession.delete({ where: { id: logoutSid } });
      }, { timeout: 10000 });
      await ready;
      const issuance = create();
      try {
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (Date.now() < deadline) {
          const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND (query LIKE '%auth_sessions%' OR query LIKE '%webgl_play_sessions%')) AS waiting`;
          if (rows[0]?.waiting) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
      } finally { release(); }
      await logout;
      expect((await issuance).statusCode).toBe(403);
      expect(await db.webglPlaySession.count({ where: { sessionId: logoutSid } })).toBe(0);
    });
    it("allows staff for staff-visible projects and rejects unrelated users", async () => {
      const otherSid = (
        await db.authSession.create({
          data: {
            userId: stranger,
            expiresAt: new Date(time.getTime() + 3600000),
            lastSeenAt: time,
          },
        })
      ).id;
      const request = () =>
        app.inject({
          method: "POST",
          url: "/api/webgl-play/sessions",
          headers: { ...headers, cookie: "sid=" + otherSid },
          payload: { projectId },
        });
      expect((await request()).statusCode).toBe(403);
      await db.user.update({
        where: { id: stranger },
        data: { role: "ADMIN" },
      });
      expect((await request()).statusCode).toBe(200);
      await db.user.update({ where: { id: stranger }, data: { role: "USER" } });
    });
    it("revokes permission changes, replacement, explicit close, and logout", async () => {
      const g = (await issue()).json().data;
      await db.project.update({
        where: { id: projectId },
        data: { creatorId: stranger },
      });
      expect((await gate(g.iframeUrl)).statusCode).toBe(403);
      await db.project.update({
        where: { id: projectId },
        data: { creatorId: owner, currentWebglDeploymentId: null },
      });
      expect((await gate(g.iframeUrl)).statusCode).toBe(403);
      await db.project.update({
        where: { id: projectId },
        data: { currentWebglDeploymentId: deploymentId },
      });
      expect((await control(g, "close")).statusCode).toBe(200);
      expect((await control(g, "close")).statusCode).toBe(200);
      expect((await gate(g.iframeUrl)).statusCode).toBe(403);
      const last = (await issue()).json().data;
      await db.authSession.delete({ where: { id: sid } });
      expect((await gate(last.iframeUrl)).statusCode).toBe(403);
      expect((await issue()).statusCode).toBe(403);
    });
  },
);
