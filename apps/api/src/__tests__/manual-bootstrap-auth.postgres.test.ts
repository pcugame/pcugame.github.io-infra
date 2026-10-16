import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GoogleAuthResponseSchema, MeResponseSchema, AdminProjectListResponseSchema } from '@pcu/contracts';
import type { GoogleTokenVerifier } from '../application/ports.js';
import { buildApp } from '../app.js';
import { createProductionBackendContext } from '../backend-context.js';
import { parseEnv } from '../config/env.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';

// No authentication bypass in the image. Only the external Google verifier is
// substituted; the production context, routes, repository and serializers run.
describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')('manual bootstrap and Google hosted-domain HTTP boundary', () => {
  let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
  let db: ReturnType<typeof database.createClient>;
  let app: FastifyInstance;
  const origin = 'https://web.pcu.test';
  const subject = randomUUID();
  const payload = { sub: subject, email: 'faculty@pcu.ac.kr', hd: 'pcu.ac.kr', name: 'Test faculty' };
  const verify = vi.fn<GoogleTokenVerifier['verify']>();
  const login = () => app.inject({ method: 'POST', url: '/api/auth/google', headers: { origin }, payload: { credential: 'isolated-fixture' } });
  const sql = (name: string) => readFile(new URL(`../../../../server/manual/sql/${name}.sql`, import.meta.url), 'utf8');

  beforeAll(async () => {
    database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);
    db = database.createClient();
    const config = parseEnv({ NODE_ENV: 'production', DATABASE_URL: process.env['DATABASE_URL'], SESSION_SECRET: 'test-session-secret-32-characters-long',
      COOKIE_SECURE: 'true', COOKIE_SAME_SITE: 'lax', GOOGLE_CLIENT_IDS: 'isolated-client', ALLOWED_GOOGLE_HD: 'pcu.ac.kr',
      CORS_ALLOWED_ORIGINS: origin, API_PUBLIC_URL: 'https://api.pcu.test', WEB_PUBLIC_URL: origin,
      PUBLIC_ASSET_ORIGIN: 'https://assets.pcu.test', S3_ENDPOINT: 'https://s3.internal.pcu.test',
      S3_PUBLIC_SIGNING_ENDPOINT: 'https://upload.pcu.test', S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT: 'https://download.pcu.test',
      S3_REGION: 'garage', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test', S3_BUCKET_PUBLIC: 'pcu-public', S3_BUCKET_PROTECTED: 'pcu-protected',
      LOG_LEVEL: 'fatal', RATE_LIMIT_LOGIN_MAX: '100',
    });
    const context = await createProductionBackendContext(config, { resources: {
      prisma: { value: db, ownership: 'borrowed' }, googleTokens: { value: { verify }, ownership: 'borrowed' },
    } });
    app = await buildApp({ context });
    await db.$executeRawUnsafe(await sql('buckets'));
  }, 60_000);
  afterAll(async () => { await app?.close(); await database?.close(); });

  it.each([
    ['subdomain', { ...payload, hd: 'g.pcu.ac.kr' }, 403],
    ['other domain', { ...payload, hd: 'example.com' }, 403],
    ['email suffix without hd', { ...payload, hd: undefined }, 403],
    ['missing subject', { ...payload, sub: undefined }, 401],
    ['missing email', { ...payload, email: undefined }, 401],
  ] as const)('rejects %s without storing a session', async (_label, result, status) => {
    verify.mockResolvedValueOnce(result);
    const before = await db.authSession.count();
    const response = await login();
    expect(response.statusCode, response.body).toBe(status);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await db.authSession.count()).toBe(before);
    expect(await db.user.count()).toBe(0);
  });

  it('rejects verifier failure without storing a session', async () => {
    verify.mockRejectedValueOnce(new Error('Invalid Google credential'));
    expect((await login()).statusCode).toBe(401);
    expect(await db.authSession.count()).toBe(0);
  });

  it('stores a real session, bootstraps exactly one admin, serializes reads/writes, expires and logs out', async () => {
    verify.mockResolvedValue(payload);
    const response = await login();
    expect(response.statusCode, response.body).toBe(200);
    expect(verify).toHaveBeenLastCalledWith('isolated-fixture', ['isolated-client']);
    const user = GoogleAuthResponseSchema.parse(response.json().data).user;
    expect(user.role).toBe('USER');
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('Secure');
    expect(response.headers['set-cookie']).toContain('SameSite=Lax');
    expect(await db.authSession.count({ where: { userId: user.id } })).toBe(1);
    const headers = { origin, cookie };
    const me = await app.inject({ url: '/api/me', headers });
    expect(me.statusCode).toBe(200);
    expect(MeResponseSchema.parse(me.json().data)).toMatchObject({ authenticated: true, user: { id: user.id } });
    expect((await app.inject({ url: '/api/admin/project-submissions/audit', headers })).statusCode).toBe(403);
    const promotion = (await sql('first-admin')).replace(":'user_id'", `'${user.id}'`).replace(":'google_subject'", `'${subject}'`);
    await expect(db.$executeRawUnsafe(promotion.replace(subject, 'wrong-subject'))).rejects.toThrow();
    // A failed multi-statement transaction remains aborted on that connection.
    await db.$executeRawUnsafe('ROLLBACK');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe('USER');
    await db.$executeRawUnsafe(promotion);
    const list = await app.inject({ url: '/api/admin/projects', headers });
    expect(list.statusCode, list.body).toBe(200);
    expect(AdminProjectListResponseSchema.parse(list.json().data).items).toEqual([]);
    const exhibition = await db.exhibition.create({ data: { year: 2099, title: 'Bootstrap test' } });
    await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: user.id, title: 'Test project', slug: `bootstrap-${subject}` } });
    const populated = await app.inject({ url: '/api/admin/projects', headers });
    expect(populated.statusCode, populated.body).toBe(200);
    expect(AdminProjectListResponseSchema.parse(populated.json().data).items).toHaveLength(1);
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['set-cookie']).toContain('sid=;');
    expect(await db.authSession.count()).toBe(0);
    expect((await app.inject({ url: '/api/admin/projects', headers })).statusCode).toBe(401);
    const again = await login();
    const expiredHeaders = { origin, cookie: String(again.headers['set-cookie']).split(';')[0] };
    await db.authSession.updateMany({ data: { expiresAt: new Date(0) } });
    expect((await app.inject({ url: '/api/admin/projects', headers: expiredHeaders })).statusCode).toBe(401);
    expect(MeResponseSchema.parse((await app.inject({ url: '/api/me', headers: expiredHeaders })).json().data)).toEqual({ authenticated: false });
  });
});
