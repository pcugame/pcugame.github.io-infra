import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createNodeFileSystem } from '../infrastructure/production-ports.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createS3Client } from '../lib/s3.js';
import { createObjectStorage } from '../lib/storage.js';
import { createProjectAssetMutationRepository } from '../modules/admin/project/asset-mutation.repository.js';
import { createExhibitionRepository } from '../modules/admin/year/repository.js';
import { createAssetsRepository } from '../modules/assets/repository.js';
import { createAssetsService } from '../modules/assets/service.js';
import { backfillImageRenditions } from '../modules/assets/image-rendition-backfill.js';
import { createOrphanRepository } from '../modules/orphan/repository.js';
import { createObjectReferenceResolver } from '../modules/orphan/reference-resolver.js';
import { createOrphanService } from '../modules/orphan/service.js';
import { createUploadIntentRepository } from '../modules/upload-intent/repository.js';
import { createUploadIntentService } from '../modules/upload-intent/service.js';
import { deriveImageRenditionStorageKey } from '../shared/responsive-image.js';

const runIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true'
	&& process.env['RUN_STORAGE_INTEGRATION'] === 'true';

describe.runIf(runIntegration)('deterministic responsive image durable lifecycle', () => {
	const testId = randomUUID();
	const prefix = `integration/responsive-image-lifecycle/${testId}`;
	const publicBucket = process.env['S3_BUCKET_PUBLIC'] ?? 'pcu-public';
	const protectedBucket = process.env['S3_BUCKET_PROTECTED'] ?? 'pcu-protected';
	const s3 = createS3Client({
		S3_ENDPOINT: process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:3900',
		S3_REGION: process.env['S3_REGION'] ?? 'garage',
		S3_ACCESS_KEY_ID: process.env['S3_ACCESS_KEY_ID'] ?? '',
		S3_SECRET_ACCESS_KEY: process.env['S3_SECRET_ACCESS_KEY'] ?? '',
		S3_FORCE_PATH_STYLE: true,
	});
	const storage = createObjectStorage(s3, { defaultPresignTtlSec: 60 });
	const objectKeys = new Set<string>();
	const outboxKeys = new Set<string>();
	let prisma!: PrismaClient;
	let userId = 0;
	let sequence = 0;

	const key = (label: string) => `${prefix}/${label}.webp`;
	const bundle = (source: string) => [
		source,
		deriveImageRenditionStorageKey(source, 'CARD_480'),
		deriveImageRenditionStorageKey(source, 'DISPLAY_960'),
	];

	async function putBundle(source: string): Promise<void> {
		for (const storageKey of bundle(source)) {
			const body = Buffer.from(storageKey);
			await storage.upload(publicBucket, storageKey, body, 'image/webp', body.length);
			objectKeys.add(storageKey);
		}
	}

	async function put(storageKey: string, body: Buffer): Promise<void> {
		await storage.upload(publicBucket, storageKey, body, 'image/webp', body.length);
		objectKeys.add(storageKey);
	}

	async function fixture() {
		sequence += 1;
		const exhibition = await prisma.exhibition.create({
			data: { year: 5000 + sequence, title: `${testId}-${sequence}` },
		});
		const project = await prisma.project.create({
			data: {
				exhibitionId: exhibition.id,
				creatorId: userId,
				slug: `${testId}-${sequence}`,
				title: 'Responsive image lifecycle',
			},
		});
		return { exhibition, project };
	}

	async function expectQueued(keys: readonly string[]): Promise<void> {
		keys.forEach((storageKey) => outboxKeys.add(storageKey));
		await expect(prisma.orphanObject.count({
			where: { bucket: publicBucket, storageKey: { in: [...keys] }, state: 'PENDING' },
		})).resolves.toBe(keys.length);
	}

	async function reap(): Promise<void> {
		const logger = { info: vi.fn(), error: vi.fn() };
		const service = createOrphanService({
			clock: { now: () => new Date(Date.now() + 10_000) },
			storage,
			repository: createOrphanRepository(prisma),
			references: createObjectReferenceResolver(
				prisma,
				{ publicBucket, protectedBucket },
				logger,
			),
			ids: { next: randomUUID },
			logger,
		});
		await prisma.orphanObject.updateMany({
			where: { storageKey: { in: [...outboxKeys] }, state: 'PENDING' },
			data: { nextAttemptAt: new Date(0) },
		});
		await service.runOrphanReaper();
	}

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required');
		prisma = createPrismaClientForDatabase(databaseUrl);
		await prisma.$connect();
		const user = await prisma.user.create({
			data: {
				googleSub: `responsive-lifecycle-${testId}`,
				email: `${testId}@example.test`,
				name: 'responsive lifecycle',
				role: 'ADMIN',
			},
		});
		userId = user.id;
	});

	afterAll(async () => {
		await prisma?.orphanObject.deleteMany({
			where: { OR: [{ storageKey: { startsWith: prefix } }, { storageKey: { in: [...outboxKeys] } }] },
		}).catch(() => undefined);
		await prisma?.project.deleteMany({ where: { creatorId: userId } }).catch(() => undefined);
		await prisma?.exhibition.deleteMany({ where: { title: { startsWith: testId } } }).catch(() => undefined);
		await prisma?.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
		await prisma?.$disconnect();
		for (const storageKey of objectKeys) {
			await storage.delete(publicBucket, storageKey).catch(() => undefined);
		}
		s3.destroy();
	});

	it('deletes an original and every deterministic rendition through the durable outbox', async () => {
		const { project } = await fixture();
		const source = key('asset-delete');
		await putBundle(source);
		const asset = await prisma.asset.create({
			data: {
				projectId: project.id,
				kind: 'IMAGE',
				storageKey: source,
				originalName: 'image.webp',
				mimeType: 'image/webp',
				sizeBytes: 1n,
				width: 1600,
				height: 900,
				card480Height: 270,
				display960Height: 540,
				isPublic: true,
			},
		});
		const service = createAssetsService({
			presign: async () => '',
			bucketForKind: () => publicBucket,
			wakeDeletionWorker: vi.fn(),
			loadProjectWithAccess: async () => ({}),
			downloadLimiter: { check: () => ({ status: 'ok' }) },
			logger: { info: vi.fn(), error: vi.fn() },
			repository: createAssetsRepository(prisma),
		});
		await service.deleteAsset(asset.id, { id: userId, role: 'ADMIN' });
		await expectQueued(bundle(source));
		await reap();
		for (const storageKey of bundle(source)) {
			await expect(storage.head(publicBucket, storageKey)).resolves.toBeNull();
		}
	});

	it('backfills deterministic objects, serves them publicly, and rejects them immediately after replacement', async () => {
		const { project } = await fixture();
		const source = key('legacy-backfill');
		const canonical = await sharp({
			create: { width: 1_200, height: 600, channels: 3, background: '#335577' },
		}).webp().toBuffer();
		await put(source, canonical);
		const asset = await prisma.asset.create({
			data: {
				projectId: project.id,
				kind: 'IMAGE',
				storageKey: source,
				originalName: 'legacy.webp',
				mimeType: 'image/webp',
				sizeBytes: BigInt(canonical.length),
				isPublic: true,
			},
		});
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const references = createObjectReferenceResolver(
			prisma,
			{ publicBucket, protectedBucket },
			logger,
		);
		const uploadIntents = createUploadIntentService({
			repository: createUploadIntentRepository(prisma),
			references,
			storage,
			clock: { now: () => new Date() },
			ids: { next: randomUUID },
			logger,
		});
		const result = await backfillImageRenditions({
			prisma,
			storage,
			fileSystem: createNodeFileSystem(),
			ids: { next: randomUUID },
			logger,
			publicBucket,
			uploadIntents,
			orphanDeletions: {
				deleteOrQueue: async (bucket, storageKey) => storage.delete(bucket, storageKey),
			},
		}, {
			apply: true,
			owner: 'asset',
			concurrency: 1,
			afterAssetId: asset.id - 1,
			limit: 1,
		});
		expect(result).toMatchObject({
			succeeded: 1,
			failed: 0,
			plannedCard480: 1,
			plannedDisplay960: 1,
		});
		const card = deriveImageRenditionStorageKey(source, 'CARD_480');
		const display = deriveImageRenditionStorageKey(source, 'DISPLAY_960');
		objectKeys.add(card);
		objectKeys.add(display);
		await expect(prisma.asset.findUnique({ where: { id: asset.id } })).resolves.toMatchObject({
			width: 1_200,
			height: 600,
			card480Height: 240,
			display960Height: 480,
		});
		await expect(prisma.uploadIntent.count({
			where: { storageKey: { in: [card, display] }, state: 'COMMITTED' },
		})).resolves.toBe(2);

		await expect(storage.head(publicBucket, card)).resolves.toMatchObject({
			contentType: 'image/webp',
		});

		const replacement = key('after-backfill-replacement');
		await createProjectAssetMutationRepository(prisma).replaceOrCreateReplaceableAsset(
			project.id,
			'IMAGE',
			{
				storageKey: replacement,
				originalName: 'replacement.webp',
				mimeType: 'image/webp',
				sizeBytes: 1n,
				width: 1_200,
				height: 600,
				renditions: [],
				isPublic: true,
			},
			{ bucket: publicBucket, reason: 'backfill-replace', playbackReason: 'backfill-replace-playback' },
		);
		await expectQueued(bundle(source));
	});

	it('replacement atomically stores readiness and retires the old generation bundle', async () => {
		const { project } = await fixture();
		const oldSource = key('replace-old');
		const nextSource = key('replace-next');
		await putBundle(oldSource);
		await prisma.asset.create({
			data: {
				projectId: project.id,
				kind: 'POSTER',
				storageKey: oldSource,
				originalName: 'old.webp',
				mimeType: 'image/webp',
				sizeBytes: 1n,
				width: 1600,
				height: 900,
				card480Height: 270,
				display960Height: 540,
				isPublic: true,
			},
		});
		const result = await createProjectAssetMutationRepository(prisma)
			.replaceOrCreateReplaceableAsset(project.id, 'POSTER', {
				storageKey: nextSource,
				originalName: 'next.webp',
				mimeType: 'image/webp',
				sizeBytes: 1n,
				width: 1200,
				height: 600,
				renditions: [
					{ profile: 'CARD_480', width: 480, height: 240 },
					{ profile: 'DISPLAY_960', width: 960, height: 480 },
				],
				isPublic: true,
			}, { bucket: publicBucket, reason: 'replace', playbackReason: 'replace-playback' });
		await expect(prisma.asset.findUnique({ where: { id: result.assetId } })).resolves.toMatchObject({
			storageKey: nextSource,
			card480Height: 240,
			display960Height: 480,
		});
		await expectQueued(bundle(oldSource));
	});

	it('allows only one concurrent backfill writer per deterministic immutable key', async () => {
		const { project } = await fixture();
		const source = key('concurrent-backfill');
		const canonical = await sharp({
			create: { width: 1_200, height: 600, channels: 3, background: '#446688' },
		}).webp().toBuffer();
		await put(source, canonical);
		const asset = await prisma.asset.create({
			data: {
				projectId: project.id,
				kind: 'IMAGE',
				storageKey: source,
				originalName: 'legacy.webp',
				mimeType: 'image/webp',
				sizeBytes: BigInt(canonical.length),
				isPublic: true,
			},
		});
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const references = createObjectReferenceResolver(
			prisma,
			{ publicBucket, protectedBucket },
			logger,
		);
		const uploadIntents = createUploadIntentService({
			repository: createUploadIntentRepository(prisma),
			references,
			storage,
			clock: { now: () => new Date() },
			ids: { next: randomUUID },
			logger,
		});
		const upload = vi.fn(storage.upload.bind(storage));
		const deleteOrQueue = vi.fn(async (bucket: string, storageKey: string) => {
			await storage.delete(bucket, storageKey);
		});
		const deps = {
			prisma,
			storage: { stream: storage.stream.bind(storage), upload },
			fileSystem: createNodeFileSystem(),
			ids: { next: randomUUID },
			logger,
			publicBucket,
			uploadIntents,
			orphanDeletions: { deleteOrQueue },
		};
		const options = {
			apply: true,
			owner: 'asset' as const,
			concurrency: 1,
			afterAssetId: asset.id - 1,
			limit: 1,
		};
		const summaries = await Promise.all([
			backfillImageRenditions(deps, options),
			backfillImageRenditions(deps, options),
		]);
		expect(summaries.reduce((sum, summary) => sum + summary.succeeded, 0)).toBe(1);
		expect(summaries.reduce((sum, summary) => sum + summary.failed, 0)).toBe(1);
		expect(upload).toHaveBeenCalledTimes(2);
		expect(deleteOrQueue).not.toHaveBeenCalled();
		const card = deriveImageRenditionStorageKey(source, 'CARD_480');
		const display = deriveImageRenditionStorageKey(source, 'DISPLAY_960');
		objectKeys.add(card);
		objectKeys.add(display);
		await expect(storage.head(publicBucket, card)).resolves.not.toBeNull();
		await expect(storage.head(publicBucket, display)).resolves.not.toBeNull();
		await expect(prisma.asset.findUnique({ where: { id: asset.id } })).resolves.toMatchObject({
			card480Height: 240,
			display960Height: 480,
		});
		await expect(prisma.uploadIntent.count({
			where: { storageKey: { in: [card, display] }, state: 'COMMITTED' },
		})).resolves.toBe(2);
	});

	it('exhibition replacement and removal reset readiness and queue both generations', async () => {
		const { exhibition } = await fixture();
		const first = key('exhibition-first');
		const second = key('exhibition-second');
		const repository = createExhibitionRepository(prisma);
		await repository.replaceExhibitionPoster(exhibition.id, {
			storageKey: first,
			originalName: 'first.webp',
			mimeType: 'image/webp',
			sizeBytes: 1n,
			width: 1600,
			height: 900,
			renditions: [{ profile: 'CARD_480', width: 480, height: 270 }],
		}, { bucket: publicBucket, reason: 'poster-replace' });
		const replaced = await repository.replaceExhibitionPoster(exhibition.id, {
			storageKey: second,
			originalName: 'second.webp',
			mimeType: 'image/webp',
			sizeBytes: 1n,
			width: 1200,
			height: 600,
			renditions: [{ profile: 'DISPLAY_960', width: 960, height: 480 }],
		}, { bucket: publicBucket, reason: 'poster-replace' });
		expect(replaced?.updated).toMatchObject({
			posterCard480Height: null,
			posterDisplay960Height: 480,
		});
		await expectQueued(bundle(first));
		const cleared = await repository.clearExhibitionPoster(
			exhibition.id,
			{ bucket: publicBucket, reason: 'poster-clear' },
		);
		expect(cleared?.updated).toMatchObject({
			posterStorageKey: null,
			posterCard480Height: null,
			posterDisplay960Height: null,
		});
		await expectQueued(bundle(second));
	});
});
