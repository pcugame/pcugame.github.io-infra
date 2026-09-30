import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
		const paths = ['index.html', 'worker.js', 'Build/game.wasm.gz'];
		await db.webglDeployment.create({ data: { id: deploymentId, projectId, sourceRepresentationId: source.representations[0]!.id, publicBucket, publicPrefix: prefix, entryObjectKey: prefix + 'index.html', state: 'READY', objectManifest: { version: 1, objects: paths.map(path => ({ objectKey: prefix + path, sizeBytes: String(path.endsWith('.html') ? Buffer.byteLength('<script>new Worker("worker.js")</script>') : path.endsWith('.gz') ? gzipSync(bytes).length : Buffer.byteLength('self.postMessage("ready")')), mimeType: path.endsWith('.html') ? 'text/html' : path.endsWith('.gz') ? 'application/wasm' : 'application/javascript' })) } } });
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
