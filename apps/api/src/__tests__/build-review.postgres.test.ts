import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createIsolatedMigratedDatabase } from './helpers/isolated-migrated-database.js';
import { createBuildReviewRepository } from '../modules/build-review/repository.js';
import { createBuildReviewService } from '../modules/build-review/service.js';
import { createBuildReviewController } from '../modules/build-review/controller.js';
import { createAssetUploadController } from '../modules/asset-upload/controller.js';
import { createAssetUploadService } from '../modules/asset-upload/service.js';
import { createAssetUploadRepository } from '../modules/asset-upload/repository.js';
import { createFileAccessController } from '../modules/file-access/controller.js';
import { createFileAccessRepository } from '../modules/file-access/repository.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { registerAuth } from '../plugins/auth.js';
import { AppError } from '../shared/errors.js';
import type { Env } from '../config/env.js';
import type { BuildInspection } from '../modules/build-package/types.js';

const inspection: BuildInspection = {
	version: 'build-package-v1',
	outcome: 'REVIEW',
	engines: [],
	evidence: ['ELF executable: game'],
	reasons: ['unverified-native-export'],
	entryCandidates: [],
	entryPath: null,
	files: [{ path: 'game', bytes: 100 }],
};
describe.runIf(process.env['RUN_POSTGRES_INTEGRATION'] === 'true')(
	'build review authenticated HTTP and durable state',
	() => {
		let database: Awaited<ReturnType<typeof createIsolatedMigratedDatabase>>,
			db: PrismaClient,
			app: FastifyInstance;
		let operatorId: number, userId: number, operatorSession: string, userSession: string, projectId: number;
		let repo: ReturnType<typeof createBuildReviewRepository>;
		const origin = 'http://localhost:5173';
		const config = {
			API_PUBLIC_URL: 'http://api.test',
			PUBLIC_ASSET_ORIGIN: 'http://files.test',
			S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT: 'http://protected.test',
			S3_BUCKET_PUBLIC: 'public',
			S3_BUCKET_PROTECTED: 'protected',
			SESSION_COOKIE_NAME: 'sid',
			SESSION_IDLE_MS: 3600000,
			FILE_GATEWAY_SECRET: 'review-test-gateway-secret-32chars',
			SESSION_TOUCH_MIN_INTERVAL_MS: 3600000,
			COOKIE_SECURE: false,
			COOKIE_SAME_SITE: 'lax',
			CORS_ALLOWED_ORIGINS: [origin],
		} as Env;
		beforeAll(async () => {
			database = await createIsolatedMigratedDatabase(process.env['DATABASE_URL']!);
			db = database.createClient();
			operatorId = (
				await db.user.create({
					data: {
						googleSub: randomUUID(),
						email: randomUUID() + '@test.invalid',
						role: 'OPERATOR',
					},
				})
			).id;
			userId = (
				await db.user.create({
					data: {
						googleSub: randomUUID(),
						email: randomUUID() + '@test.invalid',
					},
				})
			).id;
			operatorSession = (
				await db.authSession.create({
					data: {
						userId: operatorId,
						expiresAt: new Date(Date.now() + 3600000),
					},
				})
			).id;
			userSession = (
				await db.authSession.create({
					data: { userId, expiresAt: new Date(Date.now() + 3600000) },
				})
			).id;
			await db.storageBucket.createMany({
				data: [
					{ bucket: 'public', visibility: 'PUBLIC' },
					{ bucket: 'protected', visibility: 'PROTECTED' },
				],
			});
			const exhibition = await db.exhibition.create({
				data: { year: 2099, title: randomUUID(), visibility: 'PUBLIC' },
			});
			projectId = (
				await db.project.create({
					data: {
						exhibitionId: exhibition.id,
						creatorId: userId,
						slug: randomUUID(),
						title: 'Review fixture',
						status: 'PUBLISHED',
					},
				})
			).id;
			repo = createBuildReviewRepository(db);
			app = Fastify();
			app.setValidatorCompiler(validatorCompiler);
			app.setSerializerCompiler(serializerCompiler);
			await app.register(cookie);
			await registerAuth(app, {
				config,
				clock: { now: () => new Date() },
				logger: app.log,
				sessions: {
					find: (id) =>
						db.authSession.findUnique({
							where: { id },
							include: { user: true },
						}),
					touch: async () => {},
					delete: async (id) => {
						await db.authSession.delete({ where: { id } });
					},
				},
			});
			app.setErrorHandler((error, _request, reply) =>
				reply.status(error instanceof AppError ? error.statusCode : 500).send({
					ok: false,
					error: {
						code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
						message: error instanceof Error ? error.message : 'unknown',
					},
				}),
			);
			registerRouteSchemas(app);
			await app.register(
				createAssetUploadController({
					service: createAssetUploadService({
						repository: createAssetUploadRepository(db),
						storage: {
							createMultipart: async () => '',
							listParts: async () => [],
							completeMultipart: async () => {},
							head: async () => null,
							abortMultipart: async () => {},
						},
						partSigner: { presignUploadPart: async () => '' },
						clock: { now: () => new Date() },
						ids: { next: randomUUID },
						config: {
							bucket: 'protected',
							sessionTtlMs: 60000,
							partSizeBytes: 1048576,
							partUrlTtlSeconds: 60,
							partUrlRefreshMax: 20,
							maxBytesFor: async () => 1048576,
						},
						authorizeProjectWrite: async (actor, id) => {
							if (id !== projectId || ![userId, operatorId].includes(actor.id))
								throw new AppError(403, 'Denied', 'FORBIDDEN');
							return { exhibitionId: 1, status: 'PUBLISHED' };
						},
						wakeMaintenance: () => {},
					}),
				}),
				{ prefix: '/api/admin' },
			);
			await app.register(createBuildReviewController(createBuildReviewService(repo)), {
				prefix: '/api/admin',
			});
			await app.register(
				createFileAccessController(
					createFileAccessRepository(db),
					config,
					() => {},
					() => new Date(),
					async (bucket, key) => `http://protected.test/${bucket}/${key}`,
				),
				{ prefix: '/api' },
			);
		});
		afterAll(async () => {
			await app?.close();
			await database?.close();
		});
		const get = (path: string, sid = operatorSession) =>
			app.inject({
				url: '/api/admin' + path,
				headers: { origin, cookie: 'sid=' + sid },
			});
		const post = (path: string, payload: unknown, sid = operatorSession) =>
			app.inject({
				method: 'POST',
				url: path,
				headers: { origin, cookie: 'sid=' + sid },
				payload: payload as Record<string, unknown>,
			});
		const decide = (id: string, decision = 'APPROVED', reason = 'checked source') =>
			post(`/api/admin/build-reviews/${id}/decision`, {
				decision,
				reason,
				version: 1,
			});
		async function pending(submissionItemId?: string) {
			// Earlier tests finish or cancel their active slot; each new generation has a unique immutable key.
			const id = randomUUID(),
				token = randomUUID();
			const session = await db.assetUploadSession.create({
				data: {
					id,
					projectId,
					userId,
					kind: 'GAME',
					state: 'VERIFYING',
					originalName: 'game.zip',
					totalBytes: 100n,
					partSizeBytes: 100,
					totalParts: 1,
					bucket: 'protected',
					objectKey: `protected/uploads/${id}/1/source.zip`,
					sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
					sourceIdentity: 'a'.repeat(64),
					sourceIdentityBlockSizeBytes: 1048576,
					sourceIdentityBlockManifest: {},
					...(submissionItemId ? { submissionItemId } : {}),
					expiresAt: new Date(0),
					validationLeaseToken: token,
					validationLeaseUntil: new Date(Date.now() + 120000),
				},
			});
			expect(
				await repo.awaitReview({
					sessionId: id,
					generation: 1,
					sourceIdentity: session.sourceIdentity,
					token,
					inspection,
				}),
			).toBe(true);
			return await db.buildReview.findUniqueOrThrow({
				where: { sessionId_generation: { sessionId: id, generation: 1 } },
			});
		}
		it('serializes empty/populated lists and detail, denies ordinary users, releases worker leases and ignores ordinary TTL', async () => {
			expect((await get('/build-reviews')).json()).toEqual({
				ok: true,
				data: [],
			});
			const row = await pending();
			const response = await get('/build-reviews');
			expect(response.statusCode).toBe(200);
			expect(response.json().data[0]).toMatchObject({
				id: row.id,
				totalBytes: 100,
				decision: 'PENDING',
			});
			expect(response.json().data[0]).not.toHaveProperty('inspection');
			expect((await get('/build-reviews/' + row.id)).json().data).toMatchObject({ id: row.id, inspection });
			expect((await get('/build-reviews', userSession)).statusCode).toBe(403);
			const uploadStatus = await get('/direct-asset-upload-sessions/' + row.sessionId, userSession);
			expect(uploadStatus.statusCode).toBe(200);
			expect(uploadStatus.json().data).toMatchObject({
				state: 'AWAITING_REVIEW',
				review: { id: row.id, decision: 'PENDING' },
			});

			const uploads = createAssetUploadRepository(db);
			expect(await uploads.claimVerifying('GAME', 1, randomUUID(), 120000)).toEqual([]);
			expect((await uploads.expireTimedOutSessions(20)).expired).toBe(0);
			expect(
				(
					await db.assetUploadSession.findUniqueOrThrow({
						where: { id: row.sessionId },
					})
				).validationLeaseToken,
			).toBeNull();
			expect((await decide(row.id)).statusCode).toBe(200);
			expect((await decide(row.id)).statusCode).toBe(200);
			expect((await decide(row.id, 'REJECTED')).statusCode).toBe(409);
			expect(
				(
					await db.assetUploadSession.findUniqueOrThrow({
						where: { id: row.sessionId },
					})
				).state,
			).toBe('VERIFYING');
			expect(await repo.approval(row.sessionId, 1, 'b'.repeat(64))).toBeNull();
			await db.assetUploadSession.update({
				where: { id: row.sessionId },
				data: { state: 'CANCELLED' },
			});
		});
		it('rechecks current OP role on source token issuance, renewal and each gateway byte request', async () => {
			const row = await pending();
			const url = `http://api.test/api/admin/build-reviews/${row.id}/download`;
			expect((await post('/api/file-access', { url }, userSession)).statusCode).toBe(403);
			const issued = await post('/api/file-access', { url });
			expect(issued.statusCode).toBe(200);
			const grant = issued.json().data;
			const gateway = () =>
				app.inject({
					url: '/api/internal/file-access',
					headers: {
						'x-pcu-gateway-secret': config.FILE_GATEWAY_SECRET,
						'x-pcu-file-kind': 'protected',
						'x-pcu-file-uri': new URL(grant.url).pathname,
					},
				});
			expect((await gateway()).statusCode).toBe(204);
			expect((await post(`/api/file-access/${grant.token}/renew`, undefined)).statusCode).toBe(200);
			await db.user.update({
				where: { id: operatorId },
				data: { role: 'USER' },
			});
			expect((await gateway()).statusCode).toBe(403);
			expect((await post(`/api/file-access/${grant.token}/renew`, undefined)).statusCode).toBe(403);
			expect((await decide(row.id)).statusCode).toBe(403);
			await db.user.update({
				where: { id: operatorId },
				data: { role: 'OPERATOR' },
			});
			expect((await decide(row.id, 'REJECTED')).statusCode).toBe(200);
			expect((await gateway()).statusCode).toBe(403);
			const session = await db.assetUploadSession.findUniqueOrThrow({
				where: { id: row.sessionId },
			});
			expect(
				await db.orphanObject.count({
					where: { storageKey: session.objectKey },
				}),
			).toBe(1);
		});
		it('serializes competing decisions and cancellation; pending sources remain cancellable', async () => {
			const row = await pending();
			const responses = await Promise.all([decide(row.id), decide(row.id, 'REJECTED')]);
			expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
			await db.assetUploadSession.update({
				where: { id: row.sessionId },
				data: { state: 'CANCELLED' },
			});
			const next = await pending();
			const uploads = createAssetUploadRepository(db);
			expect((await uploads.cancel(next.sessionId, userId)).cancelled).toBe(true);
			expect((await decide(next.id)).statusCode).toBe(409);
			expect((await db.buildReview.findUniqueOrThrow({ where: { id: next.id } })).decision).toBe('CANCELLED');
		});
		it('keeps submission items VERIFYING while the upload awaits review', async () => {
			const previous = await db.project.findUniqueOrThrow({
				where: { id: projectId },
			});
			projectId = (
				await db.project.create({
					data: {
						exhibitionId: previous.exhibitionId,
						creatorId: userId,
						slug: randomUUID(),
						title: 'Draft review fixture',
						status: 'DRAFT',
					},
				})
			).id;
			const submission = await db.projectSubmission.create({
				data: {
					projectId,
					actorId: userId,
					items: {
						create: { kind: 'GAME', slot: 'game', clientToken: 'x'.repeat(32) },
					},
				},
				include: { items: true },
			});
			const item = submission.items[0]!;
			const row = await pending(item.id);
			expect(
				(
					await db.projectSubmissionItem.findUniqueOrThrow({
						where: { id: item.id },
					})
				).state,
			).toBe('VERIFYING');
			expect((await db.project.findUniqueOrThrow({ where: { id: projectId } })).status).toBe('DRAFT');
			expect((await decide(row.id)).statusCode).toBe(200);
			expect(
				(
					await db.projectSubmissionItem.findUniqueOrThrow({
						where: { id: item.id },
					})
				).state,
			).toBe('VERIFYING');
			await db.assetUploadSession.update({
				where: { id: row.sessionId },
				data: { state: 'CANCELLED' },
			});
		});
	},
);
