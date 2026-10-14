import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectAssetUploadCreationLookupSchema, DirectAssetUploadCreationSchema } from '@pcu/contracts';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { registerAuth } from '../plugins/auth.js';
import { AppError, forbidden } from '../shared/errors.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { createAssetUploadController } from '../modules/asset-upload/controller.js';
import { createAssetUploadRepository } from '../modules/asset-upload/repository.js';
import { createAssetUploadService } from '../modules/asset-upload/service.js';
import { createAssetUploadRecoveryService } from '../modules/asset-upload/recovery.service.js';
import { createProjectAccessRepository } from '../modules/admin/project-access.repository.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { SOURCE_IDENTITY_BLOCK_SIZE_BYTES, sourceIdentityRoot } from '../modules/admin/game-upload/source-identity.js';
import type { AssetUploadRepository } from '../modules/asset-upload/ports.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
const origin = 'http://localhost:5173';
const digest = createHash('sha256').update('fixture').digest('hex');
function body() {
	return {
		clientUploadId: randomUUID(), originalName: 'fixture.zip', totalBytes: 7,
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' as const,
		sourceIdentity: sourceIdentityRoot(7, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, [digest]),
		sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		sourceIdentityBlockDigests: [digest],
	};
}

describe.runIf(enabled)('durable direct upload creation HTTP contract (real PostgreSQL, injected storage faults)', () => {
	let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>;
	let db: PrismaClient;
	let repository: AssetUploadRepository;
	let app: FastifyInstance;
	let actorId: number;
	let otherId: number;
	let exhibitionId: number;
	let headers: { cookie: string; origin: string };
	let otherHeaders: typeof headers;
	const apps: FastifyInstance[] = [];
	const uploads = new Map<string, { key: string; uploadId: string; initiated: Date }>();
	// Storage is deliberately independent of the DB: accept-then-throw and DB
	// commit-then-throw expose the same ambiguous boundaries as remote services.
	const storage = {
		createMultipart: vi.fn(async (_bucket: string, key: string): Promise<string> => {
			const uploadId = randomUUID();
			uploads.set(uploadId, { key, uploadId, initiated: new Date(Date.now() - 3600000) });
			return uploadId;
		}),
		listParts: vi.fn(async () => []),
		completeMultipart: vi.fn(async () => {}),
		head: vi.fn(async () => null),
		abortMultipart: vi.fn(async () => {}),
		listMultipartUploads: vi.fn(async () => [...uploads.values()]),
	};

	async function createApp(overrides: Partial<AssetUploadRepository> = {}) {
		const instance = Fastify();
		apps.push(instance);
		instance.setValidatorCompiler(validatorCompiler);
		instance.setSerializerCompiler(serializerCompiler);
		await instance.register(cookie);
		await registerAuth(instance, {
			config: { SESSION_COOKIE_NAME: 'sid', SESSION_IDLE_MS: 3600000, SESSION_TOUCH_MIN_INTERVAL_MS: 3600000,
				COOKIE_SECURE: false, COOKIE_SAME_SITE: 'lax', CORS_ALLOWED_ORIGINS: [origin] },
			clock: { now: () => new Date() }, logger: instance.log,
			sessions: {
				find: id => db.authSession.findUnique({ where: { id }, include: { user: true } }),
				delete: async id => { await db.authSession.delete({ where: { id } }); },
				touch: async (id, at) => { await db.authSession.update({ where: { id }, data: { lastSeenAt: at } }); },
			},
		});
		instance.setErrorHandler((error, _request, reply) => {
			reply.status(error instanceof AppError ? error.statusCode : error instanceof Error && 'validation' in error ? 400 : 500)
				.send({ ok: false, error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : 'Error' } });
		});
		const access = createProjectAccessService(createProjectAccessRepository(db));
		const service = createAssetUploadService({
			repository: { ...repository, ...overrides }, storage,
			partSigner: { presignUploadPart: async () => 'https://storage.test/part' },
			clock: { now: () => new Date() }, ids: { next: randomUUID },
			config: { bucket: 'protected', sessionTtlMs: 60000, partSizeBytes: 5, partUrlTtlSeconds: 60, partUrlRefreshMax: 10, maxBytesFor: () => 1000 },
			authorizeProjectWrite: (actor, id) => access.loadProjectForUpload(actor as Parameters<typeof access.loadProjectForUpload>[0], id),
			authorizeExhibitionWrite: async actor => { if (!['ADMIN', 'OPERATOR'].includes(actor.role)) throw forbidden(); },
			wakeMaintenance() {},
		});
		registerRouteSchemas(instance);
		await instance.register(createAssetUploadController({ service }), { prefix: '/api/admin' });
		await instance.ready();
		return instance;
	}

	beforeAll(async () => {
		database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);
		db = database.createClient();
		repository = createAssetUploadRepository(db);
		await db.storageBucket.upsert({ where: { bucket: 'protected' }, update: {}, create: { bucket: 'protected', visibility: 'PROTECTED' } });
		actorId = (await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@example.test`, role: 'ADMIN' } })).id;
		otherId = (await db.user.create({ data: { googleSub: randomUUID(), email: `${randomUUID()}@example.test`, role: 'ADMIN' } })).id;
		for (const id of [actorId, otherId]) {
			const session = await db.authSession.create({ data: { userId: id, expiresAt: new Date(Date.now() + 3600000) } });
			if (id === actorId) headers = { cookie: `sid=${session.id}`, origin };
			else otherHeaders = { cookie: `sid=${session.id}`, origin };
		}
		exhibitionId = (await db.exhibition.create({ data: { year: 2097, title: randomUUID() } })).id;
		app = await createApp();
	}, 60000);
	beforeEach(() => { vi.clearAllMocks(); uploads.clear(); });
	afterAll(async () => {
		try { await Promise.all(apps.map(instance => instance.close())); }
		finally { await database?.close(); }
	});

	async function project() {
		return db.project.create({ data: { exhibitionId, creatorId: actorId, slug: randomUUID(), title: 'Upload recovery', status: 'PUBLISHED' } });
	}
	function post(projectId: number, payload = body(), instance = app, kind = 'game', actorHeaders = headers) {
		return instance.inject({ method: 'POST', url: `/api/admin/projects/${projectId}/direct-${kind}-upload-sessions`, headers: actorHeaders, payload });
	}
	function lookup(clientUploadId: string, instance = app, actorHeaders = headers) {
		return instance.inject({ method: 'GET', url: `/api/admin/direct-asset-upload-creations/${clientUploadId}`, headers: actorHeaders });
	}
	async function expireAndRecover(sessionId: string) {
		await db.assetUploadSession.update({ where: { id: sessionId }, data: { expiresAt: new Date(0) } });
		return createAssetUploadRecoveryService({ repository, storage, clock: { now: () => new Date() }, ids: { next: randomUUID }, logger: app.log, wakeMaintenance() {}, bucket: 'protected' }).recover();
	}

	it.each(['game', 'webgl', 'video', 'image', 'poster', 'document', 'attachment'])('recovers a lost successful %s create response across service instances', async kind => {
		const p = await project();
		const payload = body();
		const first = await post(p.id, payload, app, kind);
		expect(first.statusCode, first.body).toBe(201);
		const created = DirectAssetUploadCreationSchema.parse(first.json().data);
		expect(created).toMatchObject({ clientUploadId: payload.clientUploadId, kind: kind.toUpperCase(), state: 'UPLOADING' });
		const restarted = await createApp();
		const retry = await post(p.id, payload, restarted, kind);
		expect(retry.statusCode, retry.body).toBe(201);
		expect(retry.json().data).toEqual(created);
		const observed = await lookup(payload.clientUploadId, restarted);
		expect(observed.statusCode, observed.body).toBe(200);
		expect(DirectAssetUploadCreationLookupSchema.parse(observed.json().data)).toEqual({ status: 'OBSERVED', session: created });
		expect(storage.createMultipart).toHaveBeenCalledOnce();
		expect(await db.assetUploadSession.count({ where: { userId: actorId, clientUploadId: payload.clientUploadId } })).toBe(1);
	});

	it('converges concurrent creates while the first S3 call is still in flight', async () => {
		const p = await project();
		const payload = body();
		let release!: (id: string) => void;
		let entered!: () => void;
		const inStorage = new Promise<void>(resolve => { entered = resolve; });
		storage.createMultipart.mockImplementationOnce(async () => { entered(); return new Promise<string>(resolve => { release = resolve; }); });
		const first = post(p.id, payload).then(response => response);
		await inStorage;
		try {
			const concurrent = await post(p.id, payload, await createApp());
			expect(concurrent.statusCode, concurrent.body).toBe(201);
			expect(concurrent.json().data.state).toBe('ALLOCATING');
			expect((await lookup(payload.clientUploadId)).json().data.session.state).toBe('ALLOCATING');
			release('one-upload');
			const allocated = await first;
			expect(allocated.json().data).toMatchObject({ sessionId: concurrent.json().data.sessionId, state: 'UPLOADING' });
			expect(storage.createMultipart).toHaveBeenCalledOnce();
		} finally { release('one-upload'); await first; }
	});

	it('serializes two requests racing before either reservation exists', async () => {
		const p = await project();
		const payload = body();
		const responses = await Promise.all([post(p.id, payload), post(p.id, payload, await createApp())]);
		for (const response of responses) expect(response.statusCode, response.body).toBe(201);
		expect(responses[0]!.json().data.sessionId).toBe(responses[1]!.json().data.sessionId);
		expect(storage.createMultipart).toHaveBeenCalledOnce();
	});

	it('rejects key reuse for changed name, MIME, content, kind, owner or submission values', async () => {
		const p = await project();
		const payload = body();
		expect((await post(p.id, payload)).statusCode).toBe(201);
		const alternateDigest = 'a'.repeat(64);
		const variants = [
			{ ...payload, originalName: 'changed.zip' },
			{ ...payload, declaredMimeType: 'application/octet-stream' },
			{ ...payload, sourceIdentityBlockDigests: [alternateDigest], sourceIdentity: sourceIdentityRoot(7, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, [alternateDigest]) },
			{ ...payload, totalBytes: 8, sourceIdentity: sourceIdentityRoot(8, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, [digest]) },
			{ ...payload, submissionItem: { id: randomUUID(), clientToken: 't'.repeat(32) } },
		];
		for (const variant of variants) {
			const response = await post(p.id, variant);
			expect(response.statusCode, response.body).toBe(409);
			expect(response.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
		}
		for (const response of [await post(p.id, payload, app, 'video'), await post((await project()).id, payload)]) {
			expect(response.statusCode, response.body).toBe(409);
			expect(response.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
		}
		expect(storage.createMultipart).toHaveBeenCalledOnce();
	});

	it('rejects one of two simultaneous different requests using the same identity', async () => {
		const payload = body();
		const p = await project();
		const responses = await Promise.all([
			post(p.id, payload), post(p.id, { ...payload, originalName: 'different.zip' }, await createApp()),
		]);
		expect(responses.map(response => response.statusCode).sort()).toEqual([201, 409]);
		expect(responses.find(response => response.statusCode === 409)!.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
		expect(storage.createMultipart).toHaveBeenCalledOnce();
	});

	it('recovers exhibition and voting posters and binds the vote to the request identity', async () => {
		const votes = await Promise.all([1, 2].map(() => db.exhibitionVote.create({ data: {
			exhibitionId, title: randomUUID(), guidance: '', maxSelections: 1,
		} })));
		for (const vote of [undefined, votes[0]]) {
			const payload = { ...body(), ...(vote ? { voteId: vote.id } : {}) };
			const url = `/api/admin/exhibitions/${exhibitionId}/direct-poster-upload-sessions`;
			const first = await app.inject({ method: 'POST', url, headers, payload });
			expect(first.statusCode, first.body).toBe(201);
			const retry = await (await createApp()).inject({ method: 'POST', url, headers, payload });
			expect(retry.statusCode, retry.body).toBe(201);
			expect(retry.json().data).toEqual(first.json().data);
			expect((await lookup(payload.clientUploadId)).json().data.session).toEqual(first.json().data);
			const changedVote = await app.inject({ method: 'POST', url, headers, payload: { ...payload, voteId: votes[1]!.id } });
			expect(changedVote.statusCode, changedVote.body).toBe(409);
			expect(changedVote.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
			await db.assetUploadSession.update({ where: { id: first.json().data.sessionId }, data: { state: 'CANCELLED' } });
		}
		expect(storage.createMultipart).toHaveBeenCalledTimes(2);
	});

	it('isolates IDs by user even for another administrator with owner access', async () => {
		const payload = body();
		const created = await post((await project()).id, payload);
		expect(created.statusCode, created.body).toBe(201);
		const absent = await lookup(payload.clientUploadId, app, otherHeaders);
		expect(absent.statusCode, absent.body).toBe(200);
		expect(absent.json().data).toEqual({ status: 'NOT_OBSERVED', clientUploadId: payload.clientUploadId });
		const own = await post((await project()).id, payload, app, 'game', otherHeaders);
		expect(own.statusCode, own.body).toBe(201);
		expect(own.json().data.sessionId).not.toBe(created.json().data.sessionId);
	});

	it('rechecks current permissions for lookup and replay, and requires authentication', async () => {
		const p = await project();
		const payload = body();
		expect((await post(p.id, payload)).statusCode).toBe(201);
		try {
			await db.user.update({ where: { id: actorId }, data: { role: 'USER' } });
			await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: false } });
			expect((await lookup(payload.clientUploadId)).statusCode).toBe(403);
			expect((await post(p.id, payload)).statusCode).toBe(403);
			expect((await app.inject({ method: 'GET', url: `/api/admin/direct-asset-upload-creations/${payload.clientUploadId}` })).statusCode).toBe(401);
		} finally {
			await db.user.update({ where: { id: actorId }, data: { role: 'ADMIN' } });
			await db.exhibition.update({ where: { id: exhibitionId }, data: { isModificationEnabled: true } });
		}
	});

	it('keeps point-in-time absence and temporary lookup failure distinct from failure', async () => {
		const payload = body();
		const absent = await lookup(payload.clientUploadId);
		expect(DirectAssetUploadCreationLookupSchema.parse(absent.json().data)).toEqual({ status: 'NOT_OBSERVED', clientUploadId: payload.clientUploadId });
		const unavailable = await createApp({ findByClientUploadId: async () => { throw new Error('DB unavailable'); } });
		const failedRead = await lookup(payload.clientUploadId, unavailable);
		expect(failedRead.statusCode).toBe(500);
		expect(failedRead.json()).not.toHaveProperty('data');
		expect((await post((await project()).id, payload)).statusCode).toBe(201);
		expect((await lookup(payload.clientUploadId)).json().data.status).toBe('OBSERVED');
	});

	it.each(['READY', 'REJECTED', 'CANCELLED', 'EXPIRED'] as const)('retains %s and requires a new identity for another upload', async state => {
		const p = await project();
		const payload = body();
		const created = await post(p.id, payload);
		const sessionId = created.json().data.sessionId;
		await db.assetUploadSession.update({ where: { id: sessionId }, data: { state } });
		expect((await post(p.id, payload)).json().data).toMatchObject({ sessionId, state });
		expect((await lookup(payload.clientUploadId)).json().data.session).toMatchObject({ sessionId, state });
		const next = await post(p.id, { ...payload, clientUploadId: randomUUID() });
		expect(next.statusCode, next.body).toBe(201);
		expect(next.json().data.sessionId).not.toBe(sessionId);
		expect(storage.createMultipart).toHaveBeenCalledTimes(2);
	});

	it('observes completion and validation in progress without allocating again', async () => {
		const p = await project();
		const payload = body();
		const first = await post(p.id, payload);
		for (const state of ['COMPLETING', 'VERIFYING'] as const) {
			await db.assetUploadSession.update({ where: { id: first.json().data.sessionId }, data: { state } });
			expect((await post(p.id, payload)).json().data.state).toBe(state);
			expect((await lookup(payload.clientUploadId)).json().data.session.state).toBe(state);
		}
		expect(storage.createMultipart).toHaveBeenCalledOnce();
	});

	it('cleans accepted-but-unacknowledged S3 allocation and replays its durable failure', async () => {
		const p = await project();
		const payload = body();
		storage.createMultipart.mockImplementationOnce(async (_bucket, key) => {
			const uploadId = randomUUID();
			uploads.set(uploadId, { key, uploadId, initiated: new Date(0) });
			throw new Error('S3 accepted; response lost');
		});
		expect((await post(p.id, payload)).statusCode).toBe(503);
		const retry = await post(p.id, payload);
		expect(retry.statusCode, retry.body).toBe(201);
		expect(retry.json().data.state).toBe('REJECTED');
		const recovery = await expireAndRecover(retry.json().data.sessionId);
		expect(recovery.inventoryQueued).toBe(1);
		const task = await db.multipartAbortTask.findFirst({ where: { uploadId: [...uploads.keys()][0]! } });
		expect(task).toMatchObject({ storageKey: [...uploads.values()][0]!.key });
		expect(storage.createMultipart).toHaveBeenCalledOnce();
	});

	it.each(['before-s3', 'after-s3', 'after-db-commit'] as const)('recovers process loss at %s without repeating the external create', async boundary => {
		const p = await project();
		const payload = body();
		const interrupted = await createApp(boundary === 'before-s3' ? {
			createAllocating: async input => { await repository.createAllocating(input); throw new Error('process stopped after reservation'); },
		} : {
			setAllocated: async (...args) => {
				if (boundary === 'after-db-commit') await repository.setAllocated(...args);
				throw new Error('process stopped before returning allocation result');
			},
		});
		expect((await post(p.id, payload, interrupted)).statusCode).toBe(500);
		const retry = await post(p.id, payload, await createApp());
		expect(retry.statusCode, retry.body).toBe(201);
		expect(retry.json().data.state).toBe(boundary === 'after-db-commit' ? 'UPLOADING' : 'ALLOCATING');
		expect(storage.createMultipart).toHaveBeenCalledTimes(boundary === 'before-s3' ? 0 : 1);
		const recovered = await expireAndRecover(retry.json().data.sessionId);
		expect(recovered.expired).toBe(1);
		expect(recovered.abortsQueued).toBe(boundary === 'after-db-commit' ? 1 : 0);
		expect(recovered.inventoryQueued).toBe(boundary === 'before-s3' ? 0 : 1);
		// Both recovery paths may discover the same target; the durable queue deduplicates it.
		expect((await lookup(payload.clientUploadId)).json().data.session.state).toBe('EXPIRED');
		if (boundary !== 'before-s3') expect(await db.multipartAbortTask.count({ where: { uploadId: [...uploads.keys()][0]! } })).toBe(1);
	});

	it('replays a bound draft submission before trying to reserve its item again', async () => {
		const created = await createProjectCrudRepository(db).createProjectWithAssets({
			exhibitionId, creatorId: actorId, title: 'Submission', slug: randomUUID(), status: 'DRAFT', members: [],
			manifest: [{ kind: 'GAME', slot: 'game', clientToken: 't'.repeat(32), required: true }],
		});
		const item = created.submission.items[0]!;
		const payload = { ...body(), submissionItem: { id: item.id, clientToken: item.clientToken } };
		const first = await post(created.id, payload);
		expect(first.statusCode, first.body).toBe(201);
		const retry = await post(created.id, payload);
		expect(retry.statusCode, retry.body).toBe(201);
		expect(retry.json().data).toEqual(first.json().data);
		expect(await db.assetUploadSession.findUnique({ where: { id: first.json().data.sessionId } })).toMatchObject({ submissionItemId: item.id });
		expect(storage.createMultipart).toHaveBeenCalledOnce();
	});
});
