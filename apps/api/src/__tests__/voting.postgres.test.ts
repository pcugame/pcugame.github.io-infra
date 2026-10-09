import { createPrismaImageWorkerRepository } from '../modules/image/prisma.repository.js';
import { randomUUID, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
	VoteAdminSchema,
	VotePublicSchema,
	VoteRecordsSchema,
	DrawAdminSchema,
	type VoteAdmin,
	type DrawAdmin,
} from '@pcu/contracts';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { createVotingRepository } from '../modules/voting/repository.js';
import { createVotingService } from '../modules/voting/service.js';
import { createVotingController } from '../modules/voting/controller.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { registerAuth } from '../plugins/auth.js';
import { registerCsrf } from '../plugins/csrf.js';
import { AppError } from '../shared/errors.js';
import type { Env } from '../config/env.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { collectObjectReferences, createObjectReferenceIndex } from '../modules/orphan/reference-resolver.js';
import { createFileAccessRepository } from '../modules/file-access/repository.js';
import { createFileAccessService } from '../modules/file-access/service.js';
const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';
describe.runIf(enabled)('exhibition voting PostgreSQL and authenticated HTTP', () => {
	let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>,
		db: PrismaClient,
		app: FastifyInstance;
	let address = '';
	let exhibitionId: number, projectId: number, representationId: string, adminId: number;
	const origin = 'https://voting.fixture.example';
	const config = {
		CORS_ALLOWED_ORIGINS: [origin],
		API_PUBLIC_URL: 'https://api.fixture.example',
		PUBLIC_ASSET_ORIGIN: 'https://images.fixture.example',
		S3_BUCKET_PUBLIC: 'public',
		S3_BUCKET_PROTECTED: 'protected',
		SESSION_COOKIE_NAME: 'sid',
		SESSION_IDLE_MS: 3600000,
		SESSION_TOUCH_MIN_INTERVAL_MS: 300000,
	} as Env;
	const token = () => randomBytes(32).toString('hex');
	const req = (
		method: 'GET' | 'POST' | 'PUT',
		url: string,
		payload?: unknown,
		participant = token(),
		sid = '',
	) =>
		app.inject({
			method,
			url,
			headers: { origin, 'x-vote-participant': participant, ...(sid ? { cookie: `sid=${sid}` } : {}) },
			...(payload === undefined
				? {}
				: {
						payload: JSON.stringify(payload),
						headers: {
							origin,
							'x-vote-participant': participant,
							'content-type': 'application/json',
							...(sid ? { cookie: `sid=${sid}` } : {}),
						},
					}),
		});
	async function success(response: ReturnType<typeof req>) {
		const r = await response;
		expect(r.statusCode, r.body).toBe(200);
		return r.json().data;
	}
	async function createVote(eventId: string | null = null) {
		return VoteAdminSchema.parse(
			await success(
				req(
					'POST',
					'/api/admin/votes',
					{
						exhibitionId,
						title: '전시회 투표',
						guidance: '최대 {최대선택수}개',
						maxSelections: 2,
						state: 'OPEN',
						startsAt: null,
						endsAt: null,
						eventId,
					},
					token(),
					'admin',
				),
			),
		);
	}
	async function candidate(v: VoteAdmin) {
		return VoteAdminSchema.parse(
			await success(
				req(
					'POST',
					`/api/admin/votes/${v.id}/candidates`,
					{
						title: '익명 작품',
						representationId,
						sourceProjectId: projectId,
						active: true,
						version: v.version,
						reason: '공개 후보 등록',
					},
					token(),
					'operator',
				),
			),
		);
	}
	async function setup(eventId: string | null = null) {
		return candidate(await createVote(eventId));
	}
	async function submit(v: VoteAdmin, t = token()) {
		const b = await success(
			req(
				'POST',
				`/api/votes/${v.id}/ballots`,
				{ version: v.version, candidateIds: [v.candidates[0]!.id] },
				t,
			),
		);
		return { token: t, ballot: b };
	}
	async function update(v: VoteAdmin, settings: Partial<VoteAdmin['settings']>) {
		return VoteAdminSchema.parse(
			await success(
				req(
					'PUT',
					`/api/admin/votes/${v.id}`,
					{ version: v.version, settings: { ...v.settings, ...settings }, reason: '운영 변경' },
					token(),
					'admin',
				),
			),
		);
	}
	async function event(mode: 'FINITE' | 'WEIGHTED' = 'FINITE', remaining: number | null = 1) {
		return DrawAdminSchema.parse(
			await success(
				req(
					'POST',
					'/api/admin/draw-events',
					{
						version: 0,
						settings: {
							title: '공유 추첨',
							mode,
							paused: false,
							items: [{ title: '경품', prize: true, remaining, weight: 1, active: true }],
						},
						reason: '개설',
					},
					token(),
					'admin',
				),
			),
		);
	}
	async function freshEvent(id: string) {
		return (
			(await success(req('GET', '/api/admin/draw-events', undefined, token(), 'admin'))) as DrawAdmin[]
		).find((e) => e.id === id)!;
	}
	beforeAll(async () => {
		database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);
		db = database.createClient();
		for (const [sid, role] of [
			['admin', 'ADMIN'],
			['operator', 'OPERATOR'],
			['user', 'USER'],
		] as const) {
			const user = await db.user.create({
				data: { googleSub: randomUUID(), email: `${randomUUID()}@example.test`, name: sid, role },
			});
			if (role === 'ADMIN') adminId = user.id;
			await db.authSession.create({
				data: { id: sid, userId: user.id, expiresAt: new Date(Date.now() + 3600000), lastSeenAt: new Date() },
			});
		}
		await db.storageBucket.createMany({
			data: [
				{ bucket: 'public', visibility: 'PUBLIC' },
				{ bucket: 'protected', visibility: 'PROTECTED' },
			],
		});
		exhibitionId = (await db.exhibition.create({ data: { year: 2026, title: 'Voting' } })).id;
		projectId = (
			await db.project.create({
				data: {
					exhibitionId,
					creatorId: adminId,
					title: 'Original',
					slug: randomUUID(),
					status: 'PUBLISHED',
				},
			})
		).id;
		const asset = await db.asset.create({
			data: {
				projectId,
				kind: 'POSTER',
				representations: {
					create: ['ORIGINAL', 'CARD_480', 'DISPLAY_960'].map((role) => ({
						role: role as 'ORIGINAL' | 'CARD_480' | 'DISPLAY_960',
						bucket: 'public',
						objectKey:
							role === 'DISPLAY_960'
								? 'public/images/voting-fixture.webp'
								: `public/images/voting-${role}.webp`,
						mimeType: 'image/webp',
						state: 'READY' as const,
					})),
				},
			},
			include: { representations: true },
		});
		representationId = asset.representations.find((r) => r.role === 'DISPLAY_960')!.id;
		await db.project.update({ where: { id: projectId }, data: { posterAssetId: asset.id } });
		app = Fastify();
		app.setValidatorCompiler(validatorCompiler);
		app.setSerializerCompiler(serializerCompiler);
		registerRouteSchemas(app);
		await app.register(cookie);
		await registerAuth(app, {
			config,
			clock: { now: () => new Date() },
			logger: app.log,
			sessions: {
				find: (id) => db.authSession.findUnique({ where: { id }, include: { user: true } }),
				touch: (id, lastSeenAt) => db.authSession.update({ where: { id }, data: { lastSeenAt } }),
				delete: (id) => db.authSession.deleteMany({ where: { id } }),
			},
		});
		await registerCsrf(app, config);
		app.setErrorHandler((error: FastifyError, _request, reply) =>
			reply
				.code(error instanceof AppError ? error.statusCode : error.validation ? 400 : 500)
				.send({
					ok: false,
					error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR', message: error.message },
				}),
		);
		app.addHook('onSend', async (request, reply, payload) => {
			if (request.headers['x-test-drop-after-commit'] === '1') reply.raw.destroy();
			return payload;
		});
		await app.register(
			createVotingController(
				createVotingService(createVotingRepository(db), {
					publicOrigin: config.PUBLIC_ASSET_ORIGIN!,
					publicBucket: 'public',
					investigationSecret: 'test-only-investigation-secret-at-least-32',
				}),
			),
		);
		address = await app.listen({ port: 0, host: '127.0.0.1' });
	}, 60000);
	afterAll(async () => {
		await app?.close();
		await database?.close();
	});
	it('serializes empty authenticated lists; rejects anonymous and USER operators and untrusted Origin', async () => {
		expect(await success(req('GET', '/api/admin/votes', undefined, token(), 'admin'))).toEqual([]);
		expect((await req('GET', '/api/admin/votes')).statusCode).toBe(401);
		expect((await req('GET', '/api/admin/votes', undefined, token(), 'user')).statusCode).toBe(403);
		expect(
			(
				await app.inject({
					method: 'POST',
					url: '/api/admin/votes',
					headers: { origin: 'https://evil.test', cookie: 'sid=admin' },
					payload: {},
				})
			).statusCode,
		).toBe(403);
	});
	it('commits once for concurrent taps and retries after close; exposes only explicit anonymous fields', async () => {
		let v = await setup();
		const t = token();
		const responses = await Promise.all(
			Array.from({ length: 12 }, () =>
				success(
					req(
						'POST',
						`/api/votes/${v.id}/ballots`,
						{ version: v.version, candidateIds: [v.candidates[0]!.id] },
						t,
					),
				),
			),
		);
		expect(new Set(responses.map((b) => b.id)).size).toBe(1);
		expect(await db.voteBallot.count({ where: { voteId: v.id } })).toBe(1);
		expect(await db.voteChange.count({ where: { voteId: v.id, kind: 'BALLOT' } })).toBe(1);
		v = await update(v, { state: 'CLOSED' });
		expect((await submit({ ...v, version: 1 }, t)).ballot.id).toBe(responses[0].id);
		const view = VotePublicSchema.parse(await success(req('GET', `/api/votes/${v.id}`, undefined, t)));
		expect(view.ballot?.selections[0]?.posterUrl).toContain('voting-fixture.webp');
		expect(JSON.stringify(view)).not.toMatch(
			/participantHash|ipHash|creator|sourceProjectId|weight|remaining/,
		);
		const response = await req('GET', `/api/votes/${v.id}/records`);
		expect(response.headers['cache-control']).toBe('private, no-store');
		const records = VoteRecordsSchema.parse(response.json().data);
		expect(records.total).toBe(1);
		expect(records.totals[0]?.count).toBe(1);
		v = await update(v, { state: 'OPEN' });
		expect((await req('GET', `/api/votes/${v.id}/records`)).statusCode).toBe(403);
		const recreated = createVotingService(createVotingRepository(database.createClient()), {
			publicOrigin: config.PUBLIC_ASSET_ORIGIN!,
			publicBucket: 'public',
		});
		const hash = (await db.voteBallot.findFirstOrThrow({ where: { voteId: v.id } })).participantHash;
		expect((await recreated.view(v.id, hash)).ballot?.id).toBe(responses[0].id);
	});
	it('fences candidate edits and keeps excluded selections and totals', async () => {
		const v = await setup();
		await submit(v);
		const newer = VoteAdminSchema.parse(
			await success(
				req(
					'PUT',
					`/api/admin/votes/${v.id}/candidates/${v.candidates[0]!.id}`,
					{ title: 'Updated', sourceProjectId: null, active: false, version: v.version, reason: '후보 제외' },
					token(),
					'admin',
				),
			),
		);
		expect(
			(
				await req('POST', `/api/votes/${v.id}/ballots`, {
					version: v.version,
					candidateIds: [v.candidates[0]!.id],
				})
			).statusCode,
		).toBe(409);
		await update(newer, { state: 'CLOSED' });
		const records = VoteRecordsSchema.parse(await success(req('GET', `/api/votes/${v.id}/records`)));
		expect(records.ballots[0]?.selections[0]?.title).toBe('익명 작품');
		expect(records.totals[0]?.count).toBe(1);
		expect(records.changesTotal).toBe(2);
	});
	it('allocates the last prize atomically and retains eligibility after exhaustion/restock', async () => {
		const e = await event(),
			v = await setup(e.id),
			a = await submit(v),
			b = await submit(v);
		const results = await Promise.all([
			req('POST', `/api/votes/${v.id}/draw`, undefined, a.token),
			req('POST', `/api/votes/${v.id}/draw`, undefined, b.token),
		]);
		expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
		const winner = results[0]!.statusCode === 200 ? a : b,
			loser = winner === a ? b : a;
		expect((await db.votingDrawItem.findFirstOrThrow({ where: { eventId: e.id } })).remaining).toBe(0);
		expect(await db.voteDraw.count({ where: { eventId: e.id } })).toBe(1);
		const stale = await req(
			'PUT',
			`/api/admin/draw-events/${e.id}`,
			{
				version: e.version,
				settings: { title: e.title, mode: e.mode, paused: false, items: e.items },
				reason: 'stale restock',
			},
			token(),
			'admin',
		);
		expect(stale.statusCode).toBe(409);
		const fresh = await freshEvent(e.id);
		await success(
			req(
				'PUT',
				`/api/admin/draw-events/${e.id}`,
				{
					version: fresh.version,
					settings: {
						title: fresh.title,
						mode: fresh.mode,
						paused: false,
						items: fresh.items.map((i) => ({ ...i, remaining: 1 })),
					},
					reason: '재입고',
				},
				token(),
				'admin',
			),
		);
		await success(req('POST', `/api/votes/${v.id}/draw`, undefined, loser.token));
		const first = await success(req('POST', `/api/votes/${v.id}/draw`, undefined, winner.token));
		expect((await success(req('POST', `/api/votes/${v.id}/draw`, undefined, winner.token))).id).toBe(
			first.id,
		);
		const receipts = await Promise.all(
			Array.from({ length: 6 }, () =>
				success(req('POST', `/api/votes/${v.id}/receive`, undefined, winner.token)),
			),
		);
		expect(new Set(receipts.map((r) => r.receipt.id)).size).toBe(1);
		expect(await db.voteReceipt.count({ where: { drawId: first.id } })).toBe(1);
	});
	it('shares eligibility and one draw across votes; supports pause/reopen and late collection', async () => {
		const e = await event('WEIGHTED', null);
		let v = await setup(e.id);
		const v2 = await setup(e.id),
			a = await submit(v);
		await submit(v2, a.token);
		v = await update(v, { state: 'PAUSED' });
		const d = await success(req('POST', `/api/votes/${v.id}/draw`, undefined, a.token));
		expect((await success(req('POST', `/api/votes/${v2.id}/draw`, undefined, a.token))).id).toBe(d.id);
		const b = await submit(v2);
		await update(v2, { state: 'PAUSED' });
		expect((await req('POST', `/api/votes/${v.id}/draw`, undefined, b.token)).statusCode).toBe(403);
		v = await update(v, { state: 'OPEN' });
		await submit(v, b.token);
		await success(req('POST', `/api/votes/${v.id}/draw`, undefined, b.token));
		await db.exhibitionVote.updateMany({
			where: { eventId: e.id },
			data: { state: 'CLOSED', closedAt: new Date(Date.now() - 3600000) },
		});
		expect(
			(await success(req('POST', `/api/votes/${v.id}/receive`, undefined, a.token))).receipt,
		).not.toBeNull();
		expect(
			(
				await req(
					'PUT',
					`/api/admin/votes/${v.id}`,
					{ version: v.version, settings: { ...v.settings, eventId: null }, reason: 'disconnect' },
					token(),
					'admin',
				)
			).statusCode,
		).toBe(409);
	});
	it('uses DB time for scheduled close and grace even without a scheduler', async () => {
		const e = await event('WEIGHTED', null),
			v = await setup(e.id),
			a = await submit(v),
			b = await submit(v);
		await db.exhibitionVote.update({
			where: { id: v.id },
			data: { endsAt: new Date(Date.now() - 29 * 60000) },
		});
		expect((await success(req('GET', `/api/votes/${v.id}`, undefined, a.token))).state).toBe('CLOSED');
		await success(req('POST', `/api/votes/${v.id}/draw`, undefined, a.token));
		await db.exhibitionVote.update({
			where: { id: v.id },
			data: { endsAt: new Date(Date.now() - 30 * 60000) },
		});
		expect((await req('POST', `/api/votes/${v.id}/draw`, undefined, b.token)).statusCode).toBe(403);
		expect(
			(
				await req('POST', `/api/votes/${v.id}/ballots`, {
					version: v.version,
					candidateIds: [v.candidates[0]!.id],
				})
			).statusCode,
		).toBe(409);
	});
	it('purges expired investigation data but preserves ballots, notes, and audit', async () => {
		const v = await setup(),
			a = await submit(v);
		await success(
			req(
				'PUT',
				`/api/admin/votes/${v.id}/records/${a.ballot.id}`,
				{ flagged: true, note: '환경 정보는 동일인 증명이 아님', reason: '검토' },
				token(),
				'operator',
			),
		);
		const before = await success(
			req('GET', `/api/admin/votes/${v.id}/records?page=1`, undefined, token(), 'admin'),
		);
		expect(before.ballots[0].investigation.ipHash).toMatch(/^[a-f0-9]{64}$/);
		await db.voteInvestigation.update({ where: { ballotId: a.ballot.id }, data: { expiresAt: new Date(0) } });
		await createVotingRepository(db).purge();
		const after = await success(
			req('GET', `/api/admin/votes/${v.id}/records`, undefined, token(), 'operator'),
		);
		expect(after.ballots[0].investigation).toBeNull();
		expect(after.ballots[0].flagged).toBe(true);
		expect(await db.voteChange.count({ where: { voteId: v.id, kind: 'FLAG' } })).toBe(1);
	});
	it('rolls back candidate/audit writes and rejects duplicate ledger rows at the DB boundary', async () => {
		const v = await setup(),
			a = await submit(v);
		const row = await db.voteBallot.findUniqueOrThrow({ where: { id: a.ballot.id } });
		await expect(
			db.voteBallot.create({
				data: { voteId: v.id, participantHash: row.participantHash, version: v.version },
			}),
		).rejects.toMatchObject({ code: 'P2002' });
		await expect(
			createVotingRepository(db).transaction(async (unit) => {
				await unit.updateVote(v.id, { version: 99 });
				await unit.change({ voteId: v.id, version: 99, kind: 'CANDIDATE', reason: 'rollback', detail: {} });
				throw new Error('simulated disconnect before commit');
			}),
		).rejects.toThrow('simulated disconnect');
		expect((await db.exhibitionVote.findUniqueOrThrow({ where: { id: v.id } })).version).toBe(v.version);
		expect(await db.voteChange.count({ where: { voteId: v.id, reason: 'rollback' } })).toBe(0);
	});
	it('supports finite blanks, unlimited weighted blanks, and validates mode switches while paused', async () => {
		let e = await event('FINITE', 1);
		const save = async (settings: {
			mode?: 'FINITE' | 'WEIGHTED';
			paused?: boolean;
			items?: DrawAdmin['items'];
		}) => {
			e = await freshEvent(e.id);
			return req(
				'PUT',
				`/api/admin/draw-events/${e.id}`,
				{
					version: e.version,
					settings: { title: e.title, mode: e.mode, paused: e.paused, items: e.items, ...settings },
					reason: '추첨 변경',
				},
				token(),
				'admin',
			);
		};
		await success(save({ items: e.items.map((i) => ({ ...i, prize: false, title: '다음 기회에' })) }));
		const v = await setup(e.id),
			a = await submit(v),
			b = await submit(v);
		const result = await success(req('POST', `/api/votes/${v.id}/draw`, undefined, a.token));
		expect(result.prize).toBe(false);
		expect((await req('POST', `/api/votes/${v.id}/receive`, undefined, a.token)).statusCode).toBe(404);
		expect((await req('POST', `/api/votes/${v.id}/draw`, undefined, b.token)).statusCode).toBe(409);
		expect((await save({ mode: 'WEIGHTED', paused: false })).statusCode).toBe(409);
		await success(save({ paused: true }));
		await success(
			save({ mode: 'WEIGHTED', paused: true, items: e.items.map((i) => ({ ...i, remaining: null })) }),
		);
		await success(save({ paused: false }));
		const unlimited = await success(req('POST', `/api/votes/${v.id}/draw`, undefined, b.token));
		expect(unlimited.prize).toBe(false);
		expect((await freshEvent(e.id)).items[0]?.remaining).toBeNull();
	});
	it('commits a restarted image worker result as a vote-only poster and preserves the exhibition pointer', async () => {
		const v = await createVote(),
			sessionId = randomUUID(),
			lease = randomUUID();
		const previous = (await db.exhibition.findUniqueOrThrow({ where: { id: exhibitionId } })).posterAssetId;
		const asset = await db.asset.create({
			data: { exhibitionId, kind: 'POSTER', status: 'PROCESSING', originalName: 'vote.webp' },
		});
		const until = new Date(Date.now() + 300000),
			source = `protected/uploads/${sessionId}/source`;
		await db.assetUploadSession.create({
			data: {
				id: sessionId,
				voteId: v.id,
				exhibitionId,
				userId: adminId,
				kind: 'POSTER',
				state: 'VERIFYING',
				originalName: 'vote.webp',
				declaredMimeType: 'image/webp',
				totalBytes: 10n,
				partSizeBytes: 10,
				totalParts: 1,
				bucket: 'protected',
				objectKey: source,
				generation: 1,
				sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
				sourceIdentity: 'a'.repeat(64),
				sourceIdentityBlockSizeBytes: 1048576,
				sourceIdentityBlockManifest: '',
				validationLeaseToken: lease,
				validationLeaseUntil: until,
				resultAssetId: asset.id,
				expiresAt: until,
			},
		});
		const outputs = (['ORIGINAL', 'CARD_480', 'DISPLAY_960'] as const).map((role) => ({
			role,
			bucket: 'public',
			objectKey: `public/images/${sessionId}/${role}.webp`,
			mimeType: 'image/webp' as const,
			sizeBytes: 10,
			width: 10,
			height: 10,
			checksumSha256: 'b'.repeat(64),
			intentId: randomUUID(),
		}));
		for (const output of outputs)
			await db.uploadIntent.create({
				data: {
					id: output.intentId,
					bucket: output.bucket,
					storageKey: output.objectKey,
					purpose: 'direct-image-representation',
					ownerOperationId: sessionId,
					ownerActorId: adminId,
					ownerExhibitionId: exhibitionId,
					state: 'UPLOADED',
					notBefore: until,
				},
			});
		const worker = createPrismaImageWorkerRepository(database.createClient(), {
			publicBucket: 'public',
			protectedBucket: 'protected',
		});
		const commit = {
			session: {
				id: sessionId,
				voteId: v.id,
				kind: 'POSTER' as const,
				state: 'VERIFYING' as const,
				owner: { type: 'EXHIBITION' as const, id: String(exhibitionId) },
				actorId: String(adminId),
				originalName: 'vote.webp',
				declaredMimeType: 'image/webp',
				totalBytes: 10n,
				bucket: 'protected',
				objectKey: source,
				generation: 1,
				sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
				sourceIdentity: 'a'.repeat(64),
				sourceIdentityBlockSizeBytes: 1048576,
				sourceIdentityBlockManifest: '',
				expectedTargetAssetId: null,
				expectedTargetAssetUpdatedAt: null,
			},
			token: lease,
			assetId: String(asset.id),
			sourceCleanup: { bucket: 'protected', objectKey: source },
			outputs,
		};
		await worker.commitReady(commit);
		expect((await db.exhibition.findUniqueOrThrow({ where: { id: exhibitionId } })).posterAssetId).toBe(
			previous,
		);
		expect(await db.votePoster.count({ where: { id: sessionId } })).toBe(1);
		expect((await db.assetUploadSession.findUniqueOrThrow({ where: { id: sessionId } })).state).toBe('READY');
		await expect(worker.commitReady(commit)).rejects.toThrow('lease lost');
		const added = await success(
			req(
				'POST',
				`/api/admin/votes/${v.id}/candidates`,
				{
					title: '독립 후보',
					posterId: sessionId,
					sourceProjectId: null,
					active: true,
					version: v.version,
					reason: '전용 포스터',
				},
				token(),
				'admin',
			),
		);
		expect(added.candidates[0].posterUrl).toContain(sessionId);
		expect(await db.orphanObject.count({ where: { storageKey: source } })).toBe(1);
	});
	it('recovers committed vote, draw, and receipt after the HTTP connection is lost', async () => {
		const e = await event('WEIGHTED', null),
			v = await setup(e.id),
			participant = token();
		async function disconnect(action: string, body?: unknown) {
			await expect(
				fetch(`${address}/api/votes/${v.id}/${action}`, {
					method: 'POST',
					headers: {
						origin,
						'x-vote-participant': participant,
						'x-test-drop-after-commit': '1',
						...(body ? { 'content-type': 'application/json' } : {}),
					},
					...(body ? { body: JSON.stringify(body) } : {}),
					signal: AbortSignal.timeout(5000),
				}),
			).rejects.toThrow();
		}
		await disconnect('ballots', { version: v.version, candidateIds: [v.candidates[0]!.id] });
		const accepted = await submit(v, participant);
		expect(await db.voteBallot.count({ where: { voteId: v.id } })).toBe(1);
		expect(accepted.ballot.id).toBe((await db.voteBallot.findFirstOrThrow({ where: { voteId: v.id } })).id);
		await disconnect('draw');
		const result = await success(req('POST', `/api/votes/${v.id}/draw`, undefined, participant));
		expect(await db.voteDraw.count({ where: { eventId: e.id } })).toBe(1);
		await disconnect('receive');
		const receipt = await success(req('POST', `/api/votes/${v.id}/receive`, undefined, participant));
		expect(receipt.receipt.id).toBe(
			(await db.voteReceipt.findUniqueOrThrow({ where: { drawId: result.id } })).id,
		);
	});
	it('rejects private source posters and preserves public bytes after source deletion', async () => {
		const v = await setup();
		await submit(v);
		await db.project.update({ where: { id: projectId }, data: { visibility: 'STAFF' } });
		expect(
			(
				await req(
					'POST',
					`/api/admin/votes/${v.id}/candidates`,
					{
						title: 'Private',
						representationId,
						sourceProjectId: projectId,
						active: true,
						version: v.version,
						reason: 'bad import',
					},
					token(),
					'admin',
				)
			).statusCode,
		).toBe(403);
		await db.project.delete({ where: { id: projectId } });
		const inventory = await collectObjectReferences(
			db,
			{ publicBucket: 'public', protectedBucket: 'protected' },
			app.log,
		);
		expect(
			createObjectReferenceIndex(inventory).referencesTarget({
				bucket: 'public',
				key: 'public/images/voting-fixture.webp',
				targetKind: 'EXACT',
			}),
		).toBe(true);
		const access = createFileAccessService(createFileAccessRepository(db), config);
		expect(
			(
				await access.issue('https://images.fixture.example/public/images/voting-fixture.webp', {
					cookies: {},
				})
			).token,
		).toBeNull();
		await db.assetUploadSession.deleteMany({ where: { exhibitionId, state: 'READY' } });
		await db.exhibition.delete({ where: { id: exhibitionId } });
		expect(await db.voteBallot.count({ where: { voteId: v.id } })).toBe(1);
	});
});
