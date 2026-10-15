import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { request as httpsRequest, Agent } from 'node:https';
import { connect, type ClientHttp2Session } from 'node:http2';
import { S3Client, PutObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createProductionBackendContext, type BackendContext } from '../backend-context.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { httpActivity } from '../runtime/http-activity.js';
import { createAssetUploadRepository } from '../modules/asset-upload/repository.js';
import { createAssetUploadValidationGraph } from '../modules/asset-upload/validation-worker.composition.js';
import { createObjectStorage } from '../lib/storage.js';
import { sourceIdentityRoot } from '../modules/admin/game-upload/source-identity.js';

const enabled = process.env.RUN_ROLLING_INTEGRATION === 'true';
function command(...args: string[]) {
	const result = spawnSync(args[0]!, args.slice(1), { encoding: 'utf8', timeout: 30_000 });
	if (result.status !== 0) throw new Error(`${args[0]} failed: ${result.stderr}`);
	return result.stdout.trim();
}
async function freePort() {
	const server = createServer();
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing TCP address');
	await new Promise<void>(resolve => server.close(() => resolve()));
	return address.port;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }

describe.runIf(enabled)('actual nginx TLS HTTP/1.1 and HTTP/2 API slot handoff with PostgreSQL and Garage', () => {
	let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
	let db: ReturnType<typeof database.createClient>;
	const apps: FastifyInstance[] = [];
	const contexts: BackendContext[] = [];
	const nginx = `pcu-rolling-nginx-${process.pid}-${randomUUID().slice(0, 8)}`;
	let directory: string, apiOrigin: string, fileOrigin: string, cookie: string;
	let s3: S3Client, projectId: number, key: string, uploadSessionId: string, webglEntry: string;
	let h2: ClientHttp2Session;
	const agent = new Agent({ keepAlive: true, rejectUnauthorized: false });
	const releaseLong = deferred();
	const origin = 'http://localhost:5173';
	const secret = 'rolling-file-gateway-secret-32-characters';
	const bytes = Buffer.from('rolling release object bytes');
	const slots = new Map<string, number>();

	function request(path: string, method = 'GET', body?: unknown, base = apiOrigin) {
		return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
			const req = httpsRequest(new URL(path, base), { method, agent, rejectUnauthorized: false,
				headers: { cookie, origin, ...(method === 'OPTIONS' ? { 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type' } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) } }, response => {
				let text = '';
				response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
				response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: text }));
				response.on('error', reject);
			});
			req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
		});
	}
	function http2(path: string) {
		return new Promise<{ slot: string; status: number; body: string }>((resolve, reject) => {
			const req = h2.request({ ':path': path, cookie });
			let body = '', slot = '', status = 0;
			req.on('response', headers => { slot = String(headers['x-pcu-api-slot']); status = Number(headers[':status']); });
			req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
			req.on('end', () => resolve({ slot, status, body })); req.on('error', reject); req.end();
		});
	}

	beforeAll(async () => {
		const url = process.env.ROLLING_DATABASE_URL!;
		if (!url.includes('/rolling_test')) throw new Error('Dedicated rolling test database required');
		database = await createIsolatedMigratedDatabase(url); db = database.createClient();
		const user = await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@test.invalid`, role: 'ADMIN', name: 'Rolling test' } });
		cookie = 'sid=' + (await db.authSession.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 3600_000) } })).id;
		await db.storageBucket.createMany({ data: [{ bucket: 'pcu-public', visibility: 'PUBLIC' }, { bucket: 'pcu-protected', visibility: 'PROTECTED' }] });
		const apiPort = await freePort(), filePort = await freePort();
		apiOrigin = `https://127.0.0.1:${apiPort}`; fileOrigin = `https://127.0.0.1:${filePort}`;
		const endpoint = process.env.ROLLING_S3_ENDPOINT!;
		const credentials = { accessKeyId: 'GK000000000000000000000001', secretAccessKey: '0'.repeat(63) + '1' };
		s3 = new S3Client({ endpoint, region: 'garage', forcePathStyle: true, credentials });
		for (const slot of ['a', 'b']) {
			const port = await freePort(); slots.set(slot, port);
			const context = await createProductionBackendContext({ ...defaultTestEnv, PORT: port, LOG_LEVEL: 'error',
				GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS], CORS_ALLOWED_ORIGINS: [origin],
				API_PUBLIC_URL: apiOrigin, PUBLIC_ASSET_ORIGIN: fileOrigin,
				S3_ENDPOINT: endpoint, S3_PUBLIC_SIGNING_ENDPOINT: endpoint,
				S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT: fileOrigin,
				S3_ACCESS_KEY_ID: credentials.accessKeyId, S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
				FILE_GATEWAY_SECRET: secret, RATE_LIMIT_GLOBAL_MAX: 10000,
			}, { maintenancePaused: slot === 'b', resources: { prisma: { value: db, ownership: 'borrowed' } } });
			contexts.push(context);
			const app = await buildApp({ context }); apps.push(app);
			app.addHook('onRequest', async (_req, reply) => { reply.header('x-pcu-api-slot', slot); });
			await context.start(); await app.listen({ host: '127.0.0.1', port }); context.lifecycle.setState('ready');
		}
		directory = await mkdtemp(join(tmpdir(), 'pcu-rolling-nginx-'));
		command('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'));
		await writeFile(join(directory, 'upstream.conf'), `upstream pcu_api_active { server 127.0.0.1:${slots.get('a')}; }`);
		const template = await readFile(new URL('../../../db/public-origin.nginx.conf.template', import.meta.url), 'utf8');
		const values: Record<string, string> = { NGINX_LISTEN_PORT: `127.0.0.1:${filePort}`, FILE_GATEWAY_TLS_SERVER_NAME: '', FILE_GATEWAY_API_UPSTREAM: 'http://pcu_api_active', FILE_GATEWAY_SECRET: secret,
			GARAGE_PUBLIC_WEB_UPSTREAM: process.env.ROLLING_S3_WEB!, GARAGE_PUBLIC_WEB_TLS_SERVER_NAME: 'localhost', GARAGE_PUBLIC_BUCKET_HOST: 'pcu-public.web.garage.localhost', PUBLIC_CORS_ORIGIN_PRIMARY: origin, PUBLIC_CORS_ORIGIN_SECONDARY: 'null', WEB_PUBLIC_ORIGIN: origin };
		const tls = 'ssl_certificate /fixture/cert.pem; ssl_certificate_key /fixture/key.pem;';
		const files = template.replace(/\$\{([A-Z_]+)\}/g, (_match, name: string) => values[name] ?? '').replace(`listen 127.0.0.1:${filePort};`, `listen 127.0.0.1:${filePort} ssl; ${tls}`);
		await writeFile(join(directory, 'nginx.conf'), `events {} http { include /fixture/upstream.conf; ${files}
server { listen 127.0.0.1:${apiPort} ssl; http2 on; ${tls}
location / { proxy_pass http://pcu_api_active; proxy_http_version 1.1; proxy_set_header Host $host; proxy_read_timeout 300s; } } }`);
		command('docker', 'run', '-d', '--name', nginx, '--network', 'host', '-v', `${directory}:/fixture:ro`, 'nginx:1.27-alpine', 'nginx', '-c', '/fixture/nginx.conf', '-g', 'daemon off;');
		await vi.waitFor(async () => expect((await request('/api/health')).status).toBe(200), { timeout: 10000 });
		h2 = connect(apiOrigin, { rejectUnauthorized: false });
		// Empty collection at the actual authenticated response/serializer boundary.
		const empty = await request('/api/admin/projects');
		expect(empty.status).toBe(200); expect(JSON.parse(empty.body).data.items).toEqual([]);
		const exhibition = await db.exhibition.create({ data: { year: 2098, title: randomUUID(), visibility: 'PUBLIC' } });
		const project = await db.project.create({ data: { exhibitionId: exhibition.id, creatorId: user.id, slug: randomUUID(), title: 'Rolling fixture', status: 'PUBLISHED', visibility: 'AUTHENTICATED' } }); projectId = project.id;
		key = `public/images/rolling-${randomUUID()}.png`;
		await s3.send(new PutObjectCommand({ Bucket: 'pcu-public', Key: key, Body: bytes, ContentType: 'image/png' }));
		await db.asset.create({ data: { projectId, kind: 'IMAGE', representations: { create: [{ role: 'ORIGINAL', bucket: 'pcu-public', objectKey: key, state: 'READY', mimeType: 'image/png' }, { role: 'CARD_480', bucket: 'pcu-public', objectKey: key + '-card', state: 'READY', mimeType: 'image/webp' }, { role: 'DISPLAY_960', bucket: 'pcu-public', objectKey: key + '-display', state: 'READY', mimeType: 'image/webp' }] } } });
		const source = await db.asset.create({ data: { projectId, kind: 'WEBGL', representations: { create: {
			role: 'WEBGL_SOURCE', bucket: 'pcu-protected', objectKey: `protected/${randomUUID()}/source.zip`, state: 'READY', mimeType: 'application/zip',
		} } }, include: { representations: true } });
		const deploymentId = randomUUID(), prefix = `public/webgl/${projectId}/${deploymentId}/`;
		webglEntry = prefix + 'index.html';
		await db.webglDeployment.create({ data: { id: deploymentId, projectId,
			sourceRepresentationId: source.representations[0]!.id, publicBucket: 'pcu-public', publicPrefix: prefix,
			entryObjectKey: webglEntry, state: 'READY', objectManifest: { version: 1, objects: [
				{ objectKey: webglEntry, sizeBytes: '4', mimeType: 'text/html' },
				{ objectKey: prefix + 'Build/game.wasm', sizeBytes: '4', mimeType: 'application/wasm' },
			] },
		} });
		await db.project.update({ where: { id: projectId }, data: { currentWebglDeploymentId: deploymentId } });
		for (const object of [webglEntry, prefix + 'Build/game.wasm']) {
			await s3.send(new PutObjectCommand({ Bucket: 'pcu-public', Key: object, Body: Buffer.from('wasm') }));
		}

	}, 120_000);

	afterEach(() => { releaseLong.resolve(); });
	afterAll(async () => {
		releaseLong.resolve(); h2?.destroy(); agent.destroy();
		spawnSync('docker', ['rm', '-f', nginx], { stdio: 'ignore', timeout: 15000 });
		await Promise.all(apps.map(app => app.close()));
		s3?.destroy(); await database?.close();
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it('finishes old HTTP/1.1 + HTTP/2 work while cookie, upload and file authorization continue on the new API', async () => {
		const old = contexts[0]!, next = contexts[1]!;
		expect(next.deployment?.status()).toEqual({ paused: true, active: 0, error: false, starting: false });
		const preflight = await request('/api/file-access', 'OPTIONS');
		expect(preflight.status).toBe(204);
		expect(preflight.headers['access-control-allow-origin']).toBe(origin);
		expect(preflight.headers['access-control-allow-methods']).toContain('POST');
		const me = await request('/api/me'); expect(JSON.parse(me.body).data.authenticated).toBe(true);
		const grantResponse = await request('/api/file-access', 'POST', { url: fileOrigin + '/' + key });
		expect(grantResponse.status).toBe(200);
		const grant = JSON.parse(grantResponse.body).data as { token: string; url: string };
		expect((await request(grant.url, 'GET', undefined, fileOrigin)).body).toBe(bytes.toString());
		const play = await request('/api/file-access', 'POST', { url: fileOrigin + '/' + webglEntry });
		expect(play.status, play.body).toBe(200);
		const playUrl = (JSON.parse(play.body).data as { url: string }).url;
		const uploadBytes = Buffer.from('rolling upload attachment');
		const digest = createHash('sha256').update(uploadBytes).digest('hex');
		const init = await request(`/api/admin/projects/${projectId}/direct-attachment-upload-sessions`, 'POST', {
			originalName: 'fixture.txt', totalBytes: uploadBytes.length, declaredMimeType: 'text/plain',
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentityBlockSizeBytes: 1048576,
			sourceIdentityBlockDigests: [digest], sourceIdentity: sourceIdentityRoot(uploadBytes.length, 1048576, [digest]),
		});
		expect(init.status, init.body).toBe(201);
		const upload = JSON.parse(init.body).data as { sessionId: string; generation: number };
		uploadSessionId = upload.sessionId;
		const stored = await db.assetUploadSession.findUniqueOrThrow({ where: { id: upload.sessionId } });
		const signed = await request(`/api/admin/direct-asset-upload-sessions/${upload.sessionId}/part-urls`, 'POST', { generation: upload.generation, parts: [{ partNumber: 1, checksumSha256: Buffer.from(digest, 'hex').toString('base64') }] });
		expect(signed.status, signed.body).toBe(200);
		const part = await s3.send(new UploadPartCommand({ Bucket: stored.bucket, Key: stored.objectKey, UploadId: stored.uploadId!, PartNumber: 1, Body: uploadBytes, ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64') }));
		const entered = deferred(); let enteredCount = 0;
		const health = old.databaseHealth.check.bind(old.databaseHealth);
		vi.spyOn(old.databaseHealth, 'check').mockImplementation(async () => {
			if (++enteredCount <= 2) { if (enteredCount === 2) entered.resolve(); await releaseLong.promise; }
			return health();
		});
		const longHttp1 = request('/api/health'), longHttp2 = http2('/api/health');
		void longHttp1.catch(() => undefined); void longHttp2.catch(() => undefined);
		await entered.promise;
		const before = command('docker', 'top', nginx, '-eo', 'pid,args');
		const workers = before.split('\n').filter(line => line.includes('nginx: worker process')).map(line => line.trim().split(/\s+/)[0]!);
		expect(workers.length).toBeGreaterThan(0);
		await writeFile(join(directory, 'upstream.conf'), `upstream pcu_api_active { server 127.0.0.1:${slots.get('b')}; }`);
		command('docker', 'exec', nginx, 'nginx', '-c', '/fixture/nginx.conf', '-t');
		command('docker', 'exec', nginx, 'nginx', '-c', '/fixture/nginx.conf', '-s', 'reload');
		old.deployment?.quiesce();
		await vi.waitFor(async () => expect((await request('/api/me')).headers['x-pcu-api-slot']).toBe('b'));
		expect(httpActivity(apps[0]!).handlers).toBeGreaterThanOrEqual(2);
		const during = command('docker', 'top', nginx, '-eo', 'pid,args');
		for (const pid of workers) expect(during).toContain(pid);
		for (let i = 0; i < 20; i++) {
			const response = await request('/api/me');
			expect(response.status).toBe(200); expect(response.headers['x-pcu-api-slot']).toBe('b');
			expect(JSON.parse(response.body).data.authenticated).toBe(true);
		}
		const populated = await request('/api/admin/projects');
		expect(populated.status).toBe(200); expect(JSON.parse(populated.body).data.items).toHaveLength(1);
		const complete = await request(`/api/admin/direct-asset-upload-sessions/${upload.sessionId}/complete`, 'POST', { generation: upload.generation, parts: [{ partNumber: 1, etag: part.ETag!, sizeBytes: uploadBytes.length }] });
		expect(complete.status, complete.body).toBe(200);
		expect((await db.assetUploadSession.findUniqueOrThrow({ where: { id: upload.sessionId } })).state).toBe('VERIFYING');
		expect(grant.token).toMatch(/^[a-f0-9]{64}$/);
		const renew = await request(`/api/file-access/${grant.token}/renew`, 'POST'); expect(renew.status, renew.body).toBe(200);
		const download = await request(grant.url, 'GET', undefined, fileOrigin);
		expect(download.status).toBe(200); expect(download.headers['x-pcu-api-slot']).toBe('b'); expect(download.body).toBe(bytes.toString());
		const wasm = await request(playUrl.replace('index.html', 'Build/game.wasm'), 'GET', undefined, fileOrigin);
		expect(wasm.status, wasm.body).toBe(200); expect(wasm.body).toBe('wasm'); expect(wasm.headers['x-pcu-api-slot']).toBe('b');
		releaseLong.resolve();
		for (const result of await Promise.all([longHttp1, longHttp2])) {
			expect(result.status).toBe(200);
			expect('slot' in result ? result.slot : result.headers['x-pcu-api-slot']).toBe('a');
		}
		await vi.waitFor(() => {
			const current = command('docker', 'top', nginx, '-eo', 'pid,args');
			for (const pid of workers) expect(current.split('\n').some(line => line.trim().split(/\s+/)[0] === pid)).toBe(false);
		}, { timeout: 10000 });
		httpActivity(apps[0]!).accepting = false;
		expect(old.lifecycle.inFlight()).toBe(0); expect(httpActivity(apps[0]!).handlers).toBe(0);
		await vi.waitFor(() => expect(old.deployment?.status().active).toBe(0));
		await apps[0]!.close(); next.deployment?.resume();
		const nextPreflight = await request('/api/file-access', 'OPTIONS');
		expect(nextPreflight.status).toBe(204);
		expect(nextPreflight.headers['access-control-allow-origin']).toBe(origin);
		await vi.waitFor(() => expect(httpActivity(apps[1]!).handlers).toBe(0));
		h2.destroy(); h2 = connect(apiOrigin, { rejectUnauthorized: false });
		expect((await http2('/api/me')).slot).toBe('b');
	}, 60_000);
	it('keeps the real validation lease alive during drain and resumes queued work exactly once', async () => {
		expect(uploadSessionId).toBeDefined();
		const repository = createAssetUploadRepository(db);
		const storage = createObjectStorage(s3, { defaultPresignTtlSec: 60 });
		const entered = deferred(), finish = deferred();
		const renewal = vi.spyOn(repository, 'renewValidation');
		let pauseFirst = true;
		const graph = createAssetUploadValidationGraph({ repository,
			storage: { stream: async (...args) => {
				if (pauseFirst) { pauseFirst = false; entered.resolve(); await finish.promise; }
				return storage.stream(...args);
			} }, ids: { next: randomUUID }, tempRoot: directory, tempDiskBudgetBytes: 1024 * 1024,
			logger: { error: () => undefined }, wakeDeletionWorker: () => undefined,
		});
		const abort = new AbortController();
		const running = graph.loop.run(abort.signal);
		void running.catch(() => undefined);
		try {
			await entered.promise;
			graph.loop.gate.quiesce();
			const claimed = await db.assetUploadSession.findUniqueOrThrow({ where: { id: uploadSessionId } });
			const pendingId = randomUUID(), pendingKey = `protected/uploads/${pendingId}/1/source.bin`;
			await s3.send(new PutObjectCommand({ Bucket: claimed.bucket, Key: pendingKey, Body: Buffer.from('rolling upload attachment') }));
			await db.assetUploadSession.create({ data: { ...claimed, id: pendingId, objectKey: pendingKey,
				uploadId: null, validationLeaseToken: null, validationLeaseUntil: null, validationAttemptCount: 0,
				completionResult: undefined, sourceIdentityBlockManifest: claimed.sourceIdentityBlockManifest as string,
			} });
			await vi.waitFor(async () => {
				expect(renewal).toHaveBeenCalled();
				const current = await db.assetUploadSession.findUniqueOrThrow({ where: { id: uploadSessionId } });
				expect(current.validationLeaseUntil!.getTime()).toBeGreaterThan(claimed.validationLeaseUntil!.getTime());
			}, { timeout: 35000, interval: 500 });
			expect(graph.loop.gate.status()).toEqual({ paused: true, active: 1 });
			expect((await db.assetUploadSession.findUniqueOrThrow({ where: { id: pendingId } })).validationLeaseToken).toBeNull();
			finish.resolve();
			await vi.waitFor(() => expect(graph.loop.gate.status().active).toBe(0));
			expect((await db.assetUploadSession.findUniqueOrThrow({ where: { id: uploadSessionId } })).state).toBe('READY');
			const nextVersion = createAssetUploadValidationGraph({ repository, storage, ids: { next: randomUUID },
				tempRoot: directory, tempDiskBudgetBytes: 1024 * 1024, logger: { error: () => undefined }, wakeDeletionWorker: () => undefined });
			expect((await nextVersion.worker.runPass()).ready).toBe(1);
			expect((await nextVersion.worker.runPass()).claimed).toBe(0);
			expect(await db.asset.count({ where: { projectId, kind: 'ATTACHMENT' } })).toBe(2);
		} finally { finish.resolve(); abort.abort(); await running; }
	}, 45000);

});
