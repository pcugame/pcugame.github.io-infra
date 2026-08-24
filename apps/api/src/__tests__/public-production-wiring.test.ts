import type { S3Client } from '@aws-sdk/client-s3';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppLogger, ObjectStorage, Scheduler, SettingsStore } from '../application/ports.js';
import { buildApp } from '../app.js';
import { createProductionBackendContext, type BackendRoutes } from '../backend-context.js';
import type { Env } from '../config/env.js';
import type { PublicProductionRepository } from '../modules/public/composition.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createScriptedBackendPersistence } from './helpers/backend-persistence.js';
import { ownedTestUploadLifecycleResource } from './helpers/upload-lifecycle.js';

const emptyRoute: FastifyPluginAsync = async () => {};
const deploymentId = '123e4567-e89b-42d3-a456-426614174000';
const logger: AppLogger = {
	child: () => logger, trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
};
const settings: SettingsStore = {
	get: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
	update: async () => ({ maxGameFileMb: 5120, maxChunkSizeMb: 10 }),
	invalidate: () => {},
};

function config(label: string): Env {
	return {
		...defaultTestEnv,
		LOG_LEVEL: 'info',
		API_PUBLIC_URL: `https://api-${label}.test`,
		WEB_PUBLIC_URL: `https://web-${label}.test`,
		PUBLIC_ASSET_ORIGIN: `https://assets-${label}.test`,
		S3_BUCKET_PUBLIC: `${label}-public`,
		GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS],
		CORS_ALLOWED_ORIGINS: ['http://localhost:5173'],
	};
}

function repositoryHarness(label: string) {
	const publicPrefix = `public/webgl/7/${deploymentId}/`;
	const calls = {
		findExhibitionsWithPublishedCounts: vi.fn(async () => [{
			id: 1, year: 2026, title: `${label} Show`, posterAssetId: 10,
			poster: {
				kind: 'POSTER' as const, status: 'READY',
				representations: [{ role: 'ORIGINAL', state: 'READY', bucket: `${label}-public`, objectKey: `public/images/${label}-poster.webp`, width: 1200, height: 800 }],
			},
			_count: { projects: 1 },
		}]),
		findExhibitionsByYear: vi.fn(async (year: number) => [{ id: 1, year, title: `${label} Show` }]),
		findExhibitionById: vi.fn(async (id: number) => ({ id, year: 2026, title: `${label} Show` })),
		findPublishedProjectsInExhibitions: vi.fn(async () => []),
		findPublishedProjectById: vi.fn(async () => ({
			id: 7, exhibitionId: 1, slug: `${label}-game`, title: `${label} Game`, summary: '', description: '',
			isIncomplete: false, status: 'PUBLISHED' as const,
			currentWebglDeploymentId: deploymentId,
			currentWebglDeployment: {
				id: deploymentId, publicBucket: `${label}-public`, publicPrefix,
				entryObjectKey: `${publicPrefix}index.html`, state: 'READY',
			},
			exhibition: { year: 2026 }, members: [], poster: null,
			assets: [
				{
					id: 20, kind: 'GAME' as const,
					representations: [{ role: 'ORIGINAL', state: 'READY', bucket: `${label}-protected`, objectKey: 'protected/assets/20/original/g1.zip' }],
				},
				{
					id: 21, kind: 'VIDEO' as const,
					representations: [
						{ role: 'ORIGINAL', state: 'READY', bucket: `${label}-protected`, objectKey: 'protected/assets/21/original/g1.mov', mimeType: 'video/quicktime' },
						{ role: 'PLAYBACK', state: 'READY', bucket: `${label}-protected`, objectKey: 'protected/assets/21/playback/g1.mp4', mimeType: 'video/mp4' },
					],
				},
				{
					id: 22, kind: 'IMAGE' as const,
					representations: [
						{ role: 'ORIGINAL', state: 'READY', bucket: `${label}-public`, objectKey: 'public/images/22/original/g1.webp', width: 1200, height: 800 },
						{ role: 'CARD_480', state: 'READY', bucket: `${label}-public`, objectKey: 'public/images/22/card-480/g1.webp', width: 480, height: 320 },
					],
				},
				{
					id: 23, kind: 'VIDEO' as const,
					representations: [
						{ role: 'ORIGINAL', state: 'READY', bucket: `${label}-protected`, objectKey: 'protected/assets/23/original/g1.mov', mimeType: 'video/quicktime' },
						{ role: 'PLAYBACK', state: 'FAILED', bucket: `${label}-protected`, objectKey: 'protected/assets/23/playback/g1.mp4', mimeType: 'video/mp4', error: 'encoder failed' },
					],
				},
			],
		})),
		findPublishedProjectBySlug: vi.fn(async () => null),
	};
	const repository: PublicProductionRepository = {
		findExhibitionsWithPublishedCounts: calls.findExhibitionsWithPublishedCounts,
		findExhibitionsByYear: calls.findExhibitionsByYear,
		findPublishedProjectsInExhibitions: calls.findPublishedProjectsInExhibitions,
		findExhibitionById: calls.findExhibitionById,
		findPublishedProjectById: calls.findPublishedProjectById,
		findPublishedProjectBySlug: calls.findPublishedProjectBySlug,
	};
	return { calls, repository, publicPrefix };
}

function storageHarness() {
	const calls = { presign: vi.fn(), head: vi.fn(), stream: vi.fn() };
	const storage: ObjectStorage = {
		upload: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), head: calls.head,
		readRange: vi.fn(async () => Buffer.alloc(0)), stream: calls.stream,
		listKeys: vi.fn(async () => []), listKeyPage: vi.fn(async () => ({ keys: [], isTruncated: false })),
		deleteKeys: vi.fn(async (_bucket, keys) => ({ deleted: [...keys], failures: [] })),
		createMultipart: vi.fn(async () => 'upload-id'), uploadPart: vi.fn(async () => 'etag'),
		completeMultipart: vi.fn(async () => undefined), abortMultipart: vi.fn(async () => undefined),
		listParts: vi.fn(async () => []), listMultipartUploads: vi.fn(async () => []),
	};
	return { calls, storage };
}

async function harness(label: string) {
	const publicRepository = repositoryHarness(label);
	const storage = storageHarness();
	const scheduler: Scheduler = { every: vi.fn(() => ({ cancel: vi.fn() })), delay: vi.fn(async () => undefined) };
	const context = await createProductionBackendContext(config(label), {
		persistence: createScriptedBackendPersistence({ publicRepository: publicRepository.repository }),
		factories: {
			routes: (_config, _assets, _auth, publicGraph): BackendRoutes => ({
				auth: emptyRoute, devAuth: emptyRoute, public: publicGraph.controller,
				admin: emptyRoute, me: emptyRoute, assets: emptyRoute,
			}),
		},
		resources: {
			uploadLifecycle: ownedTestUploadLifecycleResource(),
			logger: { value: logger, ownership: 'borrowed' },
			clock: { value: { now: () => new Date('2026-07-22T00:00:00.000Z') }, ownership: 'borrowed' },
			scheduler: { value: scheduler, ownership: 'borrowed' },
			s3: { value: { send: vi.fn(), destroy: vi.fn() } as unknown as S3Client, ownership: 'borrowed' },
			storage: { value: storage.storage, ownership: 'borrowed' },
			settings: { value: settings, ownership: 'borrowed' },
		},
	});
	return { context, publicRepository, storage };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
	await Promise.allSettled(apps.splice(0).map((app) => app.close()));
});

describe('public production direct-delivery wiring', () => {
	it('does not register removed storage-key or project-id bridge routes', async () => {
		const instance = await harness('a');
		const app = await buildApp({ context: instance.context });
		apps.push(app);

		for (const url of [
			'/api/public/images/public/images/a-poster.webp',
			'/api/public/assets/public/images/a-poster.webp',
			'/api/public/webgl/7/Build/game.wasm.br',
		]) {
			const response = await app.inject({ method: 'GET', url });
			expect(response.statusCode).toBe(404);
		}
		expect(instance.storage.calls.presign).not.toHaveBeenCalled();
		expect(instance.storage.calls.head).not.toHaveBeenCalled();
		expect(instance.storage.calls.stream).not.toHaveBeenCalled();
	});

	it('returns public image and immutable WebGL generation URLs rather than API byte routes', async () => {
		const instance = await harness('a');
		const app = await buildApp({ context: instance.context });
		apps.push(app);

		const years = await app.inject({ method: 'GET', url: '/api/public/years' });
		expect(years.statusCode).toBe(200);
		expect(years.json()).toMatchObject({
			ok: true,
			data: { items: [{ poster: { original: { url: 'https://assets-a.test/public/images/a-poster.webp' } } }] },
		});

		const detail = await app.inject({ method: 'GET', url: '/api/public/projects/7' });
		expect(detail.statusCode).toBe(200);
		expect(detail.json()).toMatchObject({
			ok: true,
			data: {
				gameDownloadUrl: 'https://api-a.test/api/assets/20/download?variant=original',
				video: {
					url: 'https://api-a.test/api/assets/21/download?variant=playback',
					originalDownloadUrl: 'https://api-a.test/api/assets/21/download?variant=original',
				},
				videos: expect.arrayContaining([expect.objectContaining({
					originalDownloadUrl: 'https://api-a.test/api/assets/23/download?variant=original',
					playbackStatus: 'FAILED',
					playbackError: 'encoder failed',
				})]),
				images: [{
					id: 22,
					image: {
						original: { url: 'https://assets-a.test/public/images/22/original/g1.webp' },
						renditions: [{ url: 'https://assets-a.test/public/images/22/card-480/g1.webp' }],
					},
				}],
				webglUrl: `https://assets-a.test/${instance.publicRepository.publicPrefix}index.html`,
			},
		});
		expect(detail.json().data.webglUrl).not.toContain('/api/public/webgl/');
		expect(instance.storage.calls.stream).not.toHaveBeenCalled();
	});

	it('does not revive removed WebGL bridges for GET, HEAD, or Range', async () => {
		const instance = await harness('a');
		const app = await buildApp({ context: instance.context });
		apps.push(app);

		for (const method of ['GET', 'HEAD'] as const) {
			const response = await app.inject({
				method,
				url: '/api/public/webgl/7/Build/game.wasm.br',
				headers: { range: 'bytes=0-7' },
			});
			expect(response.statusCode).toBe(404);
		}
		expect(instance.storage.calls.head).not.toHaveBeenCalled();
		expect(instance.storage.calls.stream).not.toHaveBeenCalled();
	});
});
