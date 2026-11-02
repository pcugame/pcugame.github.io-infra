import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { createRootLogger } from '../lib/logger.js';
import { buildApp } from '../app.js';
import { createProductionBackendContext, type BackendContext } from '../backend-context.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { PrismaClient, UserRole } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';

const enabled = process.env['RUN_GATEWAY_INTEGRATION'] === 'true'
	&& process.env['RUN_POSTGRES_INTEGRATION'] === 'true' && process.env['RUN_GARAGE_INTEGRATION'] === 'true';
const api = process.env['GATEWAY_API_ORIGIN'] ?? 'http://localhost:4000';
const publicOrigin = process.env['GATEWAY_PUBLIC_ORIGIN'] ?? 'http://localhost:3904';
const protectedOrigin = process.env['GATEWAY_PROTECTED_ORIGIN'] ?? 'http://localhost:3906';
const endpoint = process.env['S3_ENDPOINT'] ?? 'http://localhost:3900';
const databaseUrl = process.env['DATABASE_URL'] ?? 'postgresql://pcu_admin:integration@localhost:15432/pcu_graduationproject_v2';
const origin = 'http://localhost:5173';
const publicBucket = 'pcu-public', protectedBucket = 'pcu-protected';
function local(value: string) {
	const url = new URL(value);
	if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Gateway fixture tests require loopback endpoints');
}
const credentials = { accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? 'GK000000000000000000000001', secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? '0000000000000000000000000000000000000000000000000000000000000001' };
type Session = { id: number; sid: string };
type Grant = { url: string; token: string | null; expiresAt: string | null };

describe.runIf(enabled)('visibility gateway live Nginx/Garage fixtures', () => {
	let db: PrismaClient, s3: S3Client, signer: S3Client;
	let owner: Session, member: Session, staff: Session, outsider: Session;
	let exhibitionId: number, projectId: number, gameId: number;
	const users: number[] = [], objects: { Bucket: string; Key: string }[] = [], tokens: string[] = [];
	const marker = `gateway-visibility-${randomUUID()}`;
	const imageKey = `public/images/${marker}/original.webp`, renditionKey = `public/images/${marker}/card.webp`, posterKey = `public/images/${marker}/poster.webp`;
	const gameKey = `protected/assets/${marker}/original.zip`;
	const otherDeploymentId = randomUUID(), otherPrefix = `public/webgl/${marker}/${otherDeploymentId}/`;
	const deploymentId = randomUUID(), prefix = `public/webgl/${marker}/${deploymentId}/`;
	const bytes = Buffer.from('0123456789abcdef');
	async function upload(Bucket: string, Key: string, Body: Buffer, ContentType: string, ContentEncoding?: string) {
		objects.push({ Bucket, Key });
		await s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType, ContentEncoding }));
	}
	async function user(role: UserRole): Promise<Session> {
		const row = await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@fixture.invalid`, name: marker, role } }); users.push(row.id);
		const session = await db.authSession.create({ data: { userId: row.id, expiresAt: new Date(Date.now() + 600_000) } }); return { id: row.id, sid: session.id };
	}
	function request(path: string, session: Session | null, payload?: unknown) {
		return fetch(api + path, { method: 'POST', headers: { origin, ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...(session ? { cookie: `sid=${session.sid}` } : {}) }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
	}
	async function grant(url: string, session: Session | null): Promise<Grant> {
		const response = await request('/api/file-access', session, { url });
		expect(response.status, await response.clone().text()).toBe(200);
		const result = (await response.json() as {data: Grant}).data;
		local(result.url); if (result.token) tokens.push(result.token); return result;
	}
	async function get(url: string, init?: RequestInit) {
		local(url); return fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
	}
	async function denied(url: string) { const response = await get(url); expect([400, 401, 403, 404]).toContain(response.status); await response.arrayBuffer(); }
	beforeAll(async () => {
		for (const value of [api, publicOrigin, protectedOrigin, endpoint, databaseUrl]) local(value);
		db = createPrismaClientForDatabase(databaseUrl);
		s3 = new S3Client({ endpoint, credentials, region: 'garage', forcePathStyle: true });
		signer = new S3Client({ endpoint: protectedOrigin, credentials, region: 'garage', forcePathStyle: true });
		// The initialized stack owns the bucket registry: these tests never change shared security settings.
		for (const bucket of [publicBucket, protectedBucket]) expect(await db.storageBucket.findUnique({ where: { bucket } })).not.toBeNull();
		owner = await user('USER'); member = await user('USER'); staff = await user('OPERATOR'); outsider = await user('USER');
		exhibitionId = (await db.exhibition.create({ data: { year: 2093, title: marker } })).id;
		projectId = (await db.project.create({ data: { exhibitionId, creatorId: owner.id, title: marker, slug: marker, status: 'PUBLISHED', members: { create: { name: 'Member', userId: member.id } } } })).id;
		await db.asset.create({ data: { projectId, kind: 'IMAGE', representations: { create: [{ role: 'ORIGINAL', bucket: publicBucket, objectKey: imageKey, state: 'READY', mimeType: 'image/webp', sizeBytes: 16 }, { role: 'CARD_480', bucket: publicBucket, objectKey: renditionKey, state: 'READY', mimeType: 'image/webp', sizeBytes: 16 }, { role: 'DISPLAY_960', bucket: publicBucket, objectKey: imageKey + '-display', state: 'READY', mimeType: 'image/webp', sizeBytes: 16 }] } } });
		const poster = await db.asset.create({ data: { exhibitionId, kind: 'POSTER', representations: { create: [{ role: 'ORIGINAL', bucket: publicBucket, objectKey: posterKey, state: 'READY', mimeType: 'image/webp', sizeBytes: 16 }, { role: 'CARD_480', bucket: publicBucket, objectKey: posterKey + '-card', state: 'READY', mimeType: 'image/webp', sizeBytes: 16 }, { role: 'DISPLAY_960', bucket: publicBucket, objectKey: posterKey + '-display', state: 'READY', mimeType: 'image/webp', sizeBytes: 16 }] } } });
		await db.exhibition.update({ where: { id: exhibitionId }, data: { posterAssetId: poster.id } });
		gameId = (await db.asset.create({ data: { projectId, kind: 'GAME', originalName: 'fixture.zip', representations: { create: { role: 'ORIGINAL', bucket: protectedBucket, objectKey: gameKey, state: 'READY', mimeType: 'application/zip', sizeBytes: 16 } } } })).id;
		const source = await db.asset.create({ data: { projectId, kind: 'WEBGL', representations: { create: { role: 'WEBGL_SOURCE', bucket: protectedBucket, objectKey: `${gameKey}-webgl`, state: 'READY', mimeType: 'application/zip' } } }, include: { representations: true } });
		const paths = ['index.html', 'worker.js', 'Build/game.wasm.gz', 'Build/game.wasm.unityweb'];
		await db.webglDeployment.create({ data: { id: deploymentId, projectId, sourceRepresentationId: source.representations[0]!.id, publicBucket, publicPrefix: prefix, entryObjectKey: prefix + 'index.html', state: 'READY', objectManifest: { version: 1, objects: paths.map(path => ({ objectKey: prefix + path, sizeBytes: String(path.endsWith('.html') ? Buffer.byteLength('<script>new Worker("worker.js")</script>') : (path.endsWith('.gz') || path.endsWith('.unityweb')) ? gzipSync(bytes).length : Buffer.byteLength('self.postMessage("ready")')), mimeType: path.endsWith('.html') ? 'text/html' : path.endsWith('.gz') ? 'application/wasm' : path.endsWith('.unityweb') ? 'application/octet-stream' : 'application/javascript' })) } } });
		await db.project.update({ where: { id: projectId }, data: { currentWebglDeploymentId: deploymentId } });
		const other = await db.project.create({ data: { exhibitionId, creatorId: owner.id, title: marker + '-other', slug: marker + '-other', status: 'PUBLISHED', visibility: 'STAFF' } });
		const otherSource = await db.asset.create({ data: { projectId: other.id, kind: 'WEBGL', representations: { create: { role: 'WEBGL_SOURCE', bucket: protectedBucket, objectKey: `${gameKey}-other`, state: 'READY', mimeType: 'application/zip' } } }, include: { representations: true } });
		await db.webglDeployment.create({ data: { id: otherDeploymentId, projectId: other.id, sourceRepresentationId: otherSource.representations[0]!.id, publicBucket, publicPrefix: otherPrefix, entryObjectKey: otherPrefix + 'index.html', state: 'READY', objectManifest: { version: 1, objects: [{ objectKey: otherPrefix + 'index.html', sizeBytes: '16', mimeType: 'text/html' }] } } });
		await db.project.update({ where: { id: other.id }, data: { currentWebglDeploymentId: otherDeploymentId } });
		await upload(publicBucket, otherPrefix + 'index.html', bytes, 'text/html');

		for (const key of [imageKey, renditionKey, posterKey]) await upload(publicBucket, key, bytes, 'image/webp');
		await upload(protectedBucket, gameKey, bytes, 'application/zip');
		await upload(publicBucket, prefix + 'index.html', Buffer.from('<script>new Worker("worker.js")</script>'), 'text/html');
		await upload(publicBucket, prefix + 'worker.js', Buffer.from('self.postMessage("ready")'), 'application/javascript');
		await upload(publicBucket, prefix + 'Build/game.wasm.gz', gzipSync(bytes), 'application/wasm', 'gzip');
		await upload(publicBucket, prefix + 'Build/game.wasm.unityweb', gzipSync(bytes), 'application/octet-stream');
	}, 30_000);
	afterAll(async () => {
		if (db) {
			await db.fileAccessToken.deleteMany({ where: { OR: [{ id: { in: tokens } }, { objectKey: { in: objects.map(object => object.Key) } }, { deploymentId: { in: [deploymentId, otherDeploymentId] } }] } });
			if (exhibitionId) await db.project.updateMany({ where: { exhibitionId }, data: { currentWebglDeploymentId: null } });
			if (exhibitionId) await db.exhibition.delete({ where: { id: exhibitionId } });
			await db.user.deleteMany({ where: { id: { in: users } } });
			await db.$disconnect();
		}
		if (s3) { for (const object of objects) await s3.send(new DeleteObjectCommand(object)); s3.destroy(); }
		signer?.destroy();
	}, 30_000);
	it('gates raw, saved signed and token files on current relationships and exhibition policy', async () => {
		for (const key of [imageKey, renditionKey, posterKey]) { const response = await get(`${publicOrigin}/${key}`); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes); }
		const signed = await getSignedUrl(signer, new GetObjectCommand({ Bucket: protectedBucket, Key: gameKey }), { expiresIn: 60 });
		expect((await get(signed)).status).toBe(200);
		const anonymousAccess = await grant(`${api}/api/assets/${gameId}/download?variant=original`, null);
		await db.project.update({ where: { id: projectId }, data: { status: 'ARCHIVED' } });
		for (const url of [`${publicOrigin}/${imageKey}`, signed, anonymousAccess.url]) expect((await get(url)).status).toBe(200);
		await db.project.update({ where: { id: projectId }, data: { visibility: 'STAFF' } });
		await denied(`${publicOrigin}/${imageKey}`); await denied(`${publicOrigin}/${renditionKey}`); await denied(signed); await denied(anonymousAccess.url);
		expect((await request('/api/file-access', outsider, { url: `${publicOrigin}/${imageKey}` })).status).toBe(403);
		for (const session of [owner, member, staff]) { const access = await grant(`${publicOrigin}/${imageKey}`, session); expect((await get(access.url)).status).toBe(200); }
		const access = await grant(`${api}/api/assets/${gameId}/download?variant=original`, owner);
		const full = await get(access.url); expect(full.status).toBe(200); expect(full.headers.get('content-disposition')).toContain('attachment'); expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
		const range = await get(access.url, { headers: { Range: 'bytes=0-7' } }); expect(range.status).toBe(206); expect(await range.text()).toBe('01234567'); expect(range.headers.get('cache-control')).toBe('private, no-store');
		const head = await get(access.url, { method: 'HEAD' }); expect(head.status).toBe(200); expect(head.headers.get('content-length')).toBe('16'); expect(await head.text()).toBe('');
		const memberAccess = await grant(`${publicOrigin}/${imageKey}`, member); await db.projectMember.deleteMany({ where: { projectId, userId: member.id } }); await denied(memberAccess.url);
		const staffAccess = await grant(`${publicOrigin}/${imageKey}`, staff); await db.user.update({ where: { id: staff.id }, data: { role: 'USER' } }); await denied(staffAccess.url); await db.user.update({ where: { id: staff.id }, data: { role: 'OPERATOR' } });
		await db.exhibition.update({ where: { id: exhibitionId }, data: { visibility: 'STAFF' } }); await denied(`${publicOrigin}/${posterKey}`); expect((await get((await grant(`${publicOrigin}/${posterKey}`, staff)).url)).status).toBe(200);
		await db.authSession.delete({ where: { id: owner.sid } }); await denied(access.url);
		const renewed = await db.authSession.create({ data: { userId: owner.id, expiresAt: new Date(Date.now() + 600_000) } }); owner.sid = renewed.id;
	});
	it('serves manifest relative workers and compressed WebGL while rejecting cross-target tokens', async () => {
		const access = await grant(`${publicOrigin}/${prefix}index.html`, owner); expect(access.url).toContain(`/play/${access.token}/index.html`);
		const entry = await get(access.url); expect(entry.status).toBe(200); expect(await entry.text()).toContain('worker.js'); expect(entry.headers.get('cross-origin-opener-policy')).toBe('same-origin'); expect(entry.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
		const worker = await get(new URL('worker.js', access.url).href); expect(worker.status).toBe(200); expect(worker.headers.get('content-type')).toContain('javascript');
		const wasm = await get(new URL('Build/game.wasm.gz', access.url).href); expect(wasm.status).toBe(200); expect(wasm.headers.get('content-type')).toContain('application/wasm'); expect(wasm.headers.get('content-encoding')).toBe('gzip'); expect(Buffer.from(await wasm.arrayBuffer())).toEqual(bytes);
		const fallback = await get(new URL('Build/game.wasm.unityweb', access.url).href);
		expect(fallback.status).toBe(200);
		expect(fallback.headers.get('content-type')).toContain('application/octet-stream');
		expect(fallback.headers.get('content-encoding')).toBeNull();
		expect(Buffer.from(await fallback.arrayBuffer())).toEqual(gzipSync(bytes));
		for (const path of ['unknown.js', '../index.html', `%252e%252e/index.html`, `${randomUUID()}/index.html`]) await denied(new URL(path, access.url).href);
		await denied(`${publicOrigin}/${imageKey}?pcu_token=${access.token}`);
		await denied(`${publicOrigin}/${otherPrefix}index.html?pcu_token=${access.token}`);
		expect((await get((await grant(`${publicOrigin}/${otherPrefix}index.html`, owner)).url)).status).toBe(200);
		const image = await grant(`${publicOrigin}/${imageKey}`, owner); await denied(`${publicOrigin}/${renditionKey}?pcu_token=${image.token}`); await denied(`${publicOrigin}/play/${image.token}/index.html`);
		await denied(`${publicOrigin}/${imageKey}?pcu_token=${'a'.repeat(64)}`);
		await db.fileAccessToken.update({ where: { id: image.token! }, data: { expiresAt: new Date(0) } }); await denied(image.url);
	});
	it('renews WebGL and protected file URLs twice beyond their original TTL', async () => {
		const access = await grant(`${publicOrigin}/${prefix}index.html`, owner);
		const download = await grant(`${api}/api/assets/${gameId}/download?variant=original`, owner);
		const originalExpiry = Math.max(Date.parse(access.expiresAt!), Date.parse(download.expiresAt!));
		for (let i = 0; i < 2; i++) {
			await delay(30_100);
			for (const current of [access, download]) {
				const response = await request(`/api/file-access/${current.token}/renew`, owner);
				expect(response.status).toBe(200);
				expect((await response.json() as {data:{token:string}}).data.token).toBe(current.token);
			}
		}
		expect(Date.now()).toBeGreaterThan(originalExpiry);
		expect((await get(access.url)).status).toBe(200);
		const downloaded = await get(download.url);
		expect(downloaded.status).toBe(200);
		expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
		await db.authSession.delete({ where: { id: owner.sid } });
		for (const current of [access, download]) {
			await denied(current.url);
			expect((await request(`/api/file-access/${current.token}/renew`, owner)).status).toBe(403);
		}
	}, 75_000);
});

// The existing integration PostgreSQL/Garage own data-plane dependencies. This
// fixture starts the real production API graph against an isolated schema and
// renders the checked-in Nginx template, never an allow-all auth upstream.
describe.runIf(enabled)('protected download client IP through the real template', () => {
 let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>, db: PrismaClient;
 let context: BackendContext, app: FastifyInstance, s3: S3Client, work: string;
 let apiOrigin: string, downloadOrigin: string, gameId: number, projectId: number, sid: string;
 let grantChecks: MockInstance<BackendContext['protectedDownloads']['check']>;
 let banChecks: MockInstance<BackendContext['protectedDownloads']['assertIpAllowed']>;
 const nginx = `pcu-download-ip-${process.pid}-${randomUUID().slice(0, 8)}`;
 const blockedIp = '127.0.0.2', allowedIp = '127.0.0.3', proxyPeer = '127.0.0.1';
 const key = `protected/assets/gateway-ip-${randomUUID()}/game.zip`;
 const bytes = Buffer.from('0123456789abcdef');
 const secret = randomUUID() + randomUUID();
 const capabilities: string[] = [];
 const observations: { surface: string; ip: string; peer: string | undefined }[] = [];
 function docker(...args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 20_000 });
  // Never emit a rendered configuration, URL, or Docker logs on failure.
  if (result.status !== 0) throw new Error(`Gateway fixture Docker ${args[0]} failed (${result.status})`);
  return result.stdout.trim();
 }
 async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, proxyPeer, resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
 }
 function wire(url: string, ip: string, method = 'GET', headers: Record<string, string> = {}) {
  local(url);
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
   const request = httpRequest(url, { localAddress: ip, method, headers, agent: false }, response => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk: Buffer) => chunks.push(chunk));
    response.on('error', () => reject(new Error('Gateway fixture response failed')));
    response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
   });
   request.setTimeout(5000, () => request.destroy(new Error('Gateway fixture timeout')));
   request.on('error', () => reject(new Error('Gateway fixture connection failed')));
   request.end();
  });
 }
 const legacy = () => `${downloadOrigin}/${protectedBucket}/${key}`;
 const normal = (ip: string, headers: Record<string, string> = {}) => wire(`${apiOrigin}/api/assets/${gameId}/download`, ip, 'GET', headers);
 async function capability(headers: Record<string, string> = {}) {
  const response = await normal(allowedIp, headers);
  expect(response.status).toBe(302);
  const url = response.headers.location;
  expect(typeof url).toBe('string');
  const parsed = new URL(url!);
  expect(parsed.origin === downloadOrigin).toBe(true);
  expect(/^\/file\/[a-f0-9]{64}$/.test(parsed.pathname)).toBe(true);
  capabilities.push(parsed.pathname.split('/').at(-1)!);
  return url!;
 }
 beforeAll(async () => {
  local(databaseUrl); local(endpoint);
  database = await createIsolatedMigratedDatabase(databaseUrl); db = database.createClient();
  await db.storageBucket.createMany({ data: [{ bucket: publicBucket, visibility: 'PUBLIC' }, { bucket: protectedBucket, visibility: 'PROTECTED' }], skipDuplicates: true });
  const owner = await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@fixture.invalid` } });
  sid = (await db.authSession.create({ data: { userId: owner.id, expiresAt: new Date(Date.now() + 600_000) } })).id;
  const exhibition = await db.exhibition.create({ data: { year: 2094, title: 'Gateway IP fixture' } });
  projectId = (await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: owner.id, title: 'Gateway IP fixture', slug: randomUUID(), status: 'PUBLISHED' } })).id;
  gameId = (await db.asset.create({ data: { projectId, kind: 'GAME', status: 'READY', originalName: 'fixture.zip', representations: { create: { role: 'ORIGINAL', bucket: protectedBucket, objectKey: key, state: 'READY', mimeType: 'application/zip', sizeBytes: bytes.length } } } })).id;
  await db.bannedIp.create({ data: { ip: blockedIp, source: 'MANUAL', reason: 'Isolated gateway regression' } });
  s3 = new S3Client({ endpoint, credentials, region: 'garage', forcePathStyle: true });
  await s3.send(new PutObjectCommand({ Bucket: protectedBucket, Key: key, Body: bytes, ContentType: 'application/zip' }));
  const apiPort = await freePort(), nginxPort = await freePort();
  apiOrigin = `http://${proxyPeer}:${apiPort}`; downloadOrigin = `http://${proxyPeer}:${nginxPort}`;
  context = await createProductionBackendContext({ ...defaultTestEnv, LOG_LEVEL: 'error',
   GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS], CORS_ALLOWED_ORIGINS: [origin],
   API_PUBLIC_URL: apiOrigin, PUBLIC_ASSET_ORIGIN: 'http://public.fixture.invalid',
   S3_ENDPOINT: endpoint, S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT: downloadOrigin,
   S3_ACCESS_KEY_ID: credentials.accessKeyId, S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
   FILE_GATEWAY_SECRET: secret, TRUST_PROXY: proxyPeer, DOWNLOAD_AUTO_IP_BAN_ENABLED: true,
  }, { resources: { prisma: { value: db, ownership: 'borrowed' }, logger: { value: createRootLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' }), ownership: 'borrowed' } } });
  // Spies call the real implementations and record only in-memory observations.
  grantChecks = vi.spyOn(context.protectedDownloads, 'check');
  banChecks = vi.spyOn(context.protectedDownloads, 'assertIpAllowed');
  app = await buildApp({ context });
  app.addHook('onRequest', async request => {
   observations.push({ surface: request.url === '/api/internal/file-access' ? 'gateway' : 'api', ip: request.ip, peer: request.socket.remoteAddress });
  });
  await context.start();
  await app.listen({ host: proxyPeer, port: apiPort });
  work = await mkdtemp(join(tmpdir(), 'pcu-download-ip-'));
  const values: Record<string, string> = {
   NGINX_RESOLVER: '127.0.0.11', NGINX_LISTEN_PORT: `${proxyPeer}:${nginxPort}`, FILE_GATEWAY_TLS_SERVER_NAME: '',
   FILE_GATEWAY_API_UPSTREAM: apiOrigin, FILE_GATEWAY_SECRET: secret,
   S3_BUCKET_PROTECTED: protectedBucket, GARAGE_S3_UPSTREAM: endpoint.replace('localhost', proxyPeer), GARAGE_S3_TLS_SERVER_NAME: 'localhost',
   PROTECTED_DOWNLOAD_GLOBAL_CONNECTIONS: '512', PROTECTED_DOWNLOAD_PER_IP_CONNECTIONS: '128',
  };
  const template = await readFile(new URL('../../../db/protected-download.nginx.conf.template', import.meta.url), 'utf8');
  const rendered = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
   if (!(name in values)) throw new Error('Unconfigured gateway fixture variable');
   return values[name]!;
  });
  await writeFile(join(work, 'nginx.conf'), `events {} http {\n${rendered}\n}`, { mode: 0o600 });
  docker('run', '-d', '--name', nginx, '--network', 'host', '--cpus', '1', '--cpu-shares', '128',
   '-v', `${join(work, 'nginx.conf')}:/etc/nginx/nginx.conf:ro`, 'nginx:1.27-alpine');
  docker('exec', nginx, 'nginx', '-t');
  for (let attempt = 0; attempt < 30; attempt++) {
   try { if ((await wire(`${downloadOrigin}/__pcu_protected_download_health`, allowedIp)).status === 204) return; } catch { /* bounded startup */ }
   await delay(100);
  }
  throw new Error('Protected gateway did not start');
 }, 30_000);
 afterAll(async () => {
  spawnSync('docker', ['rm', '-f', nginx], { stdio: 'ignore', timeout: 20_000 });
  await app?.close(); await context?.close();
  if (s3) { await s3.send(new DeleteObjectCommand({ Bucket: protectedBucket, Key: key })); s3.destroy(); }
  await database?.close();
  if (work) await rm(work, { recursive: true, force: true });
 }, 30_000);
 it('denies the blocked source IP on normal and legacy paths with the same actual client IP', async () => {
  const direct = await normal(blockedIp);
  expect(direct.status).toBe(403);
  expect(JSON.parse(direct.body.toString()).error.code).toBe('IP_BANNED');
  const before = grantChecks.mock.calls.length;
  expect((await wire(legacy(), blockedIp)).status).toBe(403);
  expect(grantChecks.mock.calls.length).toBe(before);
  expect(banChecks.mock.calls.at(-1)?.[0]).toBe(blockedIp);
  expect(observations.at(-1)).toEqual({ surface: 'gateway', ip: blockedIp, peer: proxyPeer });
 });
 it('transfers real Garage bytes, Range, HEAD and retries with one grant check and per-request ban checks', async () => {
  const grantsBefore = grantChecks.mock.calls.length;
  const url = await capability();
  expect(grantChecks.mock.calls.length - grantsBefore).toBe(1);
  const bansBefore = banChecks.mock.calls.length;
  for (const target of [url, legacy()]) {
   const full = await wire(target, allowedIp); expect(full.status).toBe(200); expect(full.body.equals(bytes)).toBe(true);
   expect(full.headers['cache-control']).toBe('private, no-store'); expect(full.headers['content-disposition']).toContain('attachment;');
   const range = await wire(target, allowedIp, 'GET', { range: 'bytes=0-7' });
   expect(range.status).toBe(206); expect(range.body.toString()).toBe('01234567'); expect(range.headers['content-range']).toBe('bytes 0-7/16');
   const head = await wire(target, allowedIp, 'HEAD'); expect(head.status).toBe(200); expect(head.body.length).toBe(0); expect(head.headers['content-length']).toBe('16');
   expect((await wire(target, allowedIp)).status).toBe(200);
  }
  expect(grantChecks.mock.calls.length - grantsBefore).toBe(1);
  expect(banChecks.mock.calls.length - bansBefore).toBe(8);
  expect(banChecks.mock.calls.slice(bansBefore).map(([ip]) => ip)).toEqual(Array(8).fill(allowedIp));
  expect(context.protectedDownloads._bucketSize()).toBe(1);
  expect(context.protectedDownloads._ipBucketSize()).toBe(1);
  console.info('Protected gateway evidence: client=127.0.0.3 peer=127.0.0.1 grant_checks=1 byte_ban_checks=8 (GET/Range/HEAD/retry, token/legacy)');
 });
 it('ignores attacker forwarding headers at both the API and protected gateway', async () => {
  const spoofAllowed = { 'x-forwarded-for': allowedIp, 'x-real-ip': allowedIp, forwarded: `for=${allowedIp}` };
  const spoofBlocked = { 'x-forwarded-for': blockedIp, 'x-real-ip': blockedIp, forwarded: `for=${blockedIp}` };
  expect((await normal(blockedIp, spoofAllowed)).status).toBe(403);
  expect(grantChecks.mock.calls.at(-1)?.[0]).toBe(blockedIp);
  expect((await wire(legacy(), blockedIp, 'GET', spoofAllowed)).status).toBe(403);
  expect(banChecks.mock.calls.at(-1)?.[0]).toBe(blockedIp);
  expect((await normal(allowedIp, spoofBlocked)).status).toBe(302);
  expect(grantChecks.mock.calls.at(-1)?.[0]).toBe(allowedIp);
  expect((await wire(legacy(), allowedIp, 'GET', spoofBlocked)).status).toBe(200);
  expect(banChecks.mock.calls.at(-1)?.[0]).toBe(allowedIp);
 });
 it('retains private-file session authorization and rechecks bans on already issued capabilities', async () => {
  await db.project.update({ where: { id: projectId }, data: { visibility: 'STAFF' } });
  const before = banChecks.mock.calls.length;
  expect((await normal(allowedIp)).status).toBe(401);
  expect((await wire(legacy(), allowedIp, 'GET', { cookie: `sid=${sid}` })).status).toBe(403);
  expect(banChecks.mock.calls.length).toBe(before);
  const url = await capability({ origin, cookie: `sid=${sid}` });
  expect((await wire(url, allowedIp)).status).toBe(200);
  expect((await wire(url, blockedIp)).status).toBe(403);
  const grantsBefore = grantChecks.mock.calls.length;
  context.protectedDownloads.addBan(allowedIp);
  expect((await wire(url, allowedIp)).status).toBe(403);
  context.protectedDownloads.removeBan(allowedIp);
  expect((await wire(url, allowedIp)).status).toBe(200);
  expect(grantChecks.mock.calls.length).toBe(grantsBefore);
  await db.authSession.delete({ where: { id: sid } });
  const bansBefore = banChecks.mock.calls.length;
  expect((await wire(url, allowedIp)).status).toBe(403);
  expect(banChecks.mock.calls.length).toBe(bansBefore);
 });
 it('keeps capabilities and secrets out of gateway logs', () => {
  const logs = docker('logs', nginx);
  expect(logs.includes('surface=file')).toBe(true);
  for (const value of [secret, credentials.secretAccessKey, sid, ...capabilities, 'X-Amz-Signature', 'pcu_token=']) {
   expect(logs.includes(value)).toBe(false);
  }
 });
});
