import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminProjectDetailSchema, PublicProjectDetailResponseSchema } from '@pcu/contracts';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { registerAuth } from '../plugins/auth.js';
import { AppError } from '../shared/errors.js';
import { registerRouteSchemas } from '../shared/http-route-schemas.js';
import { createProjectController } from '../modules/admin/project/controller.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { createProjectService } from '../modules/admin/project/service.js';
import { createProjectSerializer } from '../modules/admin/project/serializer.js';
import { assertStatusTransition } from '../modules/admin/project/project-status.service.js';
import { createProjectAccessService } from '../modules/admin/project-access.service.js';
import { createProjectAccessRepository } from '../modules/admin/project-access.repository.js';
import { createPublicController } from '../modules/public/controller.js';
import { createPublicService } from '../modules/public/service.js';
import { createPublicRepository } from '../modules/public/repository.js';
import { createAdminProjectMetadataController } from '../modules/admin/project/metadata.controller.js';
import { createSubmitProjectService } from '../modules/admin/project/project-submit.service.js';
import { createIdempotencyService } from '../modules/idempotency/service.js';
import { createIdempotencyRepository } from '../modules/idempotency/repository.js';
import { createProjectPublicationRepository } from '../modules/project-publication/repository.js';
import { createProjectPublicationWorker } from '../modules/project-publication/worker.js';

const enabled = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';

describe.runIf(enabled)('Phase 2 project HTTP response compatibility', () => {
	let db: PrismaClient;
	let app: FastifyInstance;
	let exhibitionId: number;
	let adminId: number;
	let sessionCookie: string;
	const apiOrigin = 'http://localhost:3000';
	const publicOrigin = 'https://assets.example.test';
	let protectedBucket = 'protected';
	let publicBucket = 'public';

	beforeAll(async () => {
		db = createPrismaClientForDatabase(process.env['DATABASE_URL']!);
		adminId = (await db.user.create({ data: {
			googleSub: randomUUID(), email: `${randomUUID()}@test.invalid`, role: 'ADMIN',
		} })).id;
		const session = await db.authSession.create({ data: {
			userId: adminId, expiresAt: new Date(Date.now() + 3600000),
		} });
		sessionCookie = `sid=${session.id}`;
		exhibitionId = (await db.exhibition.create({ data: { year: 2098, title: randomUUID() } })).id;
		// The contracted registry has one bucket per visibility; reuse its names.
		protectedBucket = (await db.storageBucket.findFirst({ where: { visibility: 'PROTECTED' } }))?.bucket ?? protectedBucket;
		publicBucket = (await db.storageBucket.findFirst({ where: { visibility: 'PUBLIC' } }))?.bucket ?? publicBucket;
		for (const [bucket, visibility] of [[protectedBucket, 'PROTECTED'], [publicBucket, 'PUBLIC']] as const) {
			await db.storageBucket.upsert({ where: { bucket }, update: {}, create: { bucket, visibility } });
		}

		app = Fastify();
		app.setValidatorCompiler(validatorCompiler);
		app.setSerializerCompiler(serializerCompiler);
		await app.register(cookie);
		await app.register(multipart);
		await registerAuth(app, {
			config: {
				SESSION_COOKIE_NAME: 'sid', SESSION_IDLE_MS: 3600000,
				SESSION_TOUCH_MIN_INTERVAL_MS: 3600000, COOKIE_SECURE: false,
				COOKIE_SAME_SITE: 'lax', CORS_ALLOWED_ORIGINS: ['http://localhost:5173'],
			},
			clock: { now: () => new Date() }, logger: app.log,
			sessions: {
				find: (id) => db.authSession.findUnique({ where: { id }, include: { user: true } }),
				delete: async (id) => { await db.authSession.delete({ where: { id } }); },
				touch: async (id, at) => { await db.authSession.update({ where: { id }, data: { lastSeenAt: at } }); },
			},
		});
		app.setErrorHandler((error, _request, reply) => {
			reply.status(error instanceof AppError ? error.statusCode : 500).send({
				ok: false, error: {
					code: error instanceof AppError ? error.code : 'ERROR',
					message: error instanceof Error ? error.message : 'Error',
				},
			});
		});
		const repository = createProjectCrudRepository(db);
		const service = createProjectService({
			repository,
			serializeProjectDetail: createProjectSerializer(apiOrigin, {
				publicAssetOrigin: publicOrigin, publicBucket,
			}).serializeProjectDetail,
			deletionBuckets: { publicBucket, protectedBucket },
			abortMultipart: async () => {}, wakeDeletionWorker() {}, wakeMaintenance() {}, logger: app.log,
		});
		registerRouteSchemas(app);
		await app.register(createAdminProjectMetadataController({
			service: createSubmitProjectService({
				webPublicUrl: 'http://localhost:5173', repository,
				idempotency: createIdempotencyService({
					repository: createIdempotencyRepository(db), clock: { now: () => new Date() },
				}),
			}),
			route: { rateLimit: { max: 30, timeWindow: 3600000 } },
		}), { prefix: '/api/admin' });
		await app.register(createProjectController({
			service, access: createProjectAccessService(createProjectAccessRepository(db)),
			status: {
				assertTransition: assertStatusTransition,
				bulkUpdate: async (ids, status) => ({ updated: (await repository.bulkUpdateStatus(ids, status)).count }),
			},
		}), { prefix: '/api/admin' });
		await app.register(createPublicController({ service: createPublicService({
			apiPublicUrl: apiOrigin, publicAssetOrigin: publicOrigin, publicBucket,
			repository: createPublicRepository(db),
		}) }), { prefix: '/api/public' });
	});

	afterAll(async () => {
		await app?.close();
		if (!db) return;
		if (exhibitionId) await db.exhibition.delete({ where: { id: exhibitionId } });
		if (adminId) await db.user.delete({ where: { id: adminId } });
		await db.$disconnect();
	});

	it.each([false, true])('serializes authenticated detail and PATCH with populated materials=%s', async (populated) => {
		const project = await db.project.create({ data: {
			exhibitionId, creatorId: adminId, title: 'Before', slug: randomUUID(), status: 'PUBLISHED',
		} });
		const attachments = [];
		if (populated) {
			for (const [kind, name, mimeType] of [
				['DOCUMENT', '설명서.pdf', 'application/pdf'],
				['ATTACHMENT', 'source.zip', 'application/zip'],
			] as const) {
				const asset = await db.asset.create({ data: {
					projectId: project.id, kind, status: 'READY', originalName: name,
					representations: { create: {
						role: 'ORIGINAL', state: 'READY', bucket: protectedBucket,
						objectKey: `protected/projects/${project.id}/${name}`, mimeType, sizeBytes: 1024n,
					} },
				} });
				attachments.push({
					assetId: asset.id, kind, originalName: name, mimeType, sizeBytes: 1024,
					downloadUrl: `${apiOrigin}/api/assets/${asset.id}/download?variant=original`,
				});
			}
		}
		for (const method of ['GET', 'PATCH'] as const) {
			const response = await app.inject({
				method, url: `/api/admin/projects/${project.id}`,
				headers: { cookie: sessionCookie, origin: 'http://localhost:5173' },
				...(method === 'PATCH' ? { payload: { title: 'Updated' } } : {}),
			});
			expect(response.statusCode, response.body).toBe(200);
			const detail = AdminProjectDetailSchema.parse(response.json().data);
			expect(detail.attachments).toEqual(attachments);
			expect(detail.assets).toHaveLength(attachments.length);
			expect(detail.videos).toEqual([]);
			expect(detail.title).toBe(method === 'PATCH' ? 'Updated' : 'Before');
		}
		expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).title).toBe('Updated');
		const publicResponse = await app.inject({ method: 'GET', url: `/api/public/projects/${project.id}` });
		expect(publicResponse.statusCode, publicResponse.body).toBe(200);
		const publicDetail = PublicProjectDetailResponseSchema.parse(publicResponse.json().data);
		expect(publicDetail.attachments).toEqual(attachments);
		expect(publicDetail.title).toBe('Updated');
		expect((await app.inject({ method: 'GET', url: `/api/admin/projects/${project.id}` })).statusCode).toBe(401);
	});

	it('publishes metadata with an empty manifest through the actual durable worker', async () => {
		const boundary = `metadata-${randomUUID()}`;
		const title = `Metadata only ${randomUUID()}`;
		const created = await app.inject({
			method: 'POST', url: '/api/admin/projects/submit',
			headers: {
				cookie: sessionCookie, origin: 'http://localhost:5173',
				'idempotency-key': randomUUID(), 'content-type': `multipart/form-data; boundary=${boundary}`,
			},
			payload: `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify({
				exhibitionId, title, members: [{ name: 'Metadata author', studentId: '20980001' }], manifest: [],
			})}\r\n--${boundary}--\r\n`,
		});
		expect(created.statusCode, created.body).toBe(201);
		const projectId = created.json().data.id as number;
		expect(created.json().data).toMatchObject({ status: 'DRAFT', items: [] });
		expect((await app.inject({ method: 'GET', url: `/api/public/projects/${projectId}` })).statusCode).toBe(404);
		const finalized = await app.inject({
			method: 'POST', url: `/api/admin/projects/${projectId}/submission/finalize`,
			headers: { cookie: sessionCookie, origin: 'http://localhost:5173' },
		});
		expect(finalized.statusCode, finalized.body).toBe(200);
		expect(finalized.json().data).toMatchObject({ state: 'FINALIZING', projectStatus: 'DRAFT' });
		const unexpectedStorage = async (): Promise<never> => { throw new Error('Empty manifest must not access object storage'); };
		const worker = createProjectPublicationWorker({
			repository: createProjectPublicationRepository(db),
			storage: { head: unexpectedStorage, stream: unexpectedStorage, upload: unexpectedStorage, delete: unexpectedStorage },
			ids: { next: randomUUID }, logger: app.log,
		});
		await expect(worker.runPass()).resolves.toMatchObject({ completed: 1 });
		const status = await app.inject({ method: 'GET', url: `/api/admin/projects/${projectId}/submission`, headers: { cookie: sessionCookie, origin: 'http://localhost:5173' } });
		expect(status.statusCode, status.body).toBe(200);
		expect(status.json().data).toMatchObject({ state: 'PUBLISHED', projectStatus: 'PUBLISHED', publicationState: 'COMPLETED', items: [] });
		const published = await app.inject({ method: 'GET', url: `/api/public/projects/${projectId}` });
		expect(published.statusCode, published.body).toBe(200);
		expect(PublicProjectDetailResponseSchema.parse(published.json().data)).toMatchObject({ title, attachments: [], status: 'PUBLISHED' });
	});

});
