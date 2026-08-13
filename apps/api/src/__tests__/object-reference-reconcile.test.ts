import { describe, expect, it, vi } from 'vitest';
import type { ObjectStorage } from '../application/ports.js';

const referenceResolverMocks = vi.hoisted(() => ({
	createObjectReferenceIndex: vi.fn(),
	createdIndexes: [] as Array<{ referencesTarget: ReturnType<typeof vi.fn> }>,
}));

vi.mock('../modules/orphan/reference-resolver.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../modules/orphan/reference-resolver.js')>();
	referenceResolverMocks.createObjectReferenceIndex.mockImplementation(
		(inventory) => {
			const index = actual.createObjectReferenceIndex(inventory);
			const wrappedIndex = {
				...index,
				referencesTarget: vi.fn(index.referencesTarget),
			};
			referenceResolverMocks.createdIndexes.push(wrappedIndex);
			return wrappedIndex;
		},
	);
	return {
		...actual,
		createObjectReferenceIndex: referenceResolverMocks.createObjectReferenceIndex,
	};
});

import {
	parseReconcileOptions,
	reconcileObjects,
} from '../modules/orphan/reconcile.js';
import {
	collectObjectReferences,
	createObjectReferenceIndex,
	targetsOverlap,
} from '../modules/orphan/reference-resolver.js';

const deploymentId = '11111111-1111-4111-8111-111111111111';

function referenceClient(input: { malformedWebgl?: boolean } = {}) {
	const gameUploadSession = {
		findMany: vi.fn()
			.mockResolvedValueOnce([{ id: 'completed', storageKey: 'game/completed.zip' }])
			.mockResolvedValueOnce([
				{ id: 'pending', s3Key: 'game/pending.zip' },
				{ id: 'completing', s3Key: 'game/completing.zip' },
			]),
	};
	return {
		asset: {
			findMany: vi.fn().mockResolvedValue([
				{
					id: 1,
					storageKey: 'images/original.png',
					playbackStorageKey: 'images/playback.webp',
					isPublic: true,
					card480Height: null,
					display960Height: null,
				},
				{
					id: 2,
					storageKey: 'videos/original.mp4',
					playbackStorageKey: null,
					isPublic: false,
					card480Height: null,
					display960Height: null,
				},
			]),
		},
		exhibition: {
			findMany: vi.fn().mockResolvedValue([
				{
					id: 3,
					posterStorageKey: 'posters/exhibition.png',
					posterCard480Height: null,
					posterDisplay960Height: null,
				},
			]),
		},
		project: {
			findMany: vi.fn().mockResolvedValue([{
				id: 7,
				webglEntryKey: input.malformedWebgl
					? 'webgl/not-safe/index.html'
					: `webgl/7/${deploymentId}/site/index.html`,
			}]),
		},
		gameUploadSession,
		uploadIntent: {
			findMany: vi.fn().mockResolvedValue([{
				id: 'intent',
				bucket: 'protected',
				storageKey: 'intent/in-flight.zip',
			}]),
		},
	};
}

describe('authoritative object reference inventory', () => {
	it('collects every live pointer with bucket and exact/prefix semantics', async () => {
		const client = referenceClient();
		const logger = { error: vi.fn() };
		const inventory = await collectObjectReferences(
			client as never,
			{ publicBucket: 'public', protectedBucket: 'protected' },
			logger,
		);

		expect(inventory.references).toEqual(expect.arrayContaining([
			expect.objectContaining({ bucket: 'public', key: 'images/original.png', targetKind: 'EXACT' }),
			expect.objectContaining({ bucket: 'public', key: 'images/playback.webp', targetKind: 'EXACT' }),
			expect.objectContaining({ bucket: 'protected', key: 'videos/original.mp4', targetKind: 'EXACT' }),
			expect.objectContaining({ bucket: 'public', key: 'posters/exhibition.png', targetKind: 'EXACT' }),
			expect.objectContaining({
				bucket: 'public',
				key: `webgl/7/${deploymentId}/site/`,
				targetKind: 'PREFIX',
			}),
			expect.objectContaining({
				bucket: 'protected',
				key: `webgl/7/${deploymentId}/source.zip`,
				targetKind: 'EXACT',
			}),
			expect.objectContaining({ bucket: 'protected', key: 'game/completed.zip' }),
			expect.objectContaining({ bucket: 'protected', key: 'game/pending.zip' }),
			expect.objectContaining({ bucket: 'protected', key: 'game/completing.zip' }),
			expect.objectContaining({ bucket: 'protected', key: 'intent/in-flight.zip' }),
		]));
		expect(client.asset.findMany).toHaveBeenCalledWith(expect.objectContaining({
			where: { status: { not: 'DELETED' } },
		}));
		const referenceIndex = createObjectReferenceIndex(inventory);
		expect(referenceIndex.referencesTarget({
			bucket: 'public',
			targetKind: 'EXACT',
			key: 'images/original.png',
		})).toBe(true);
		expect(referenceIndex.referencesTarget({
			bucket: 'public',
			targetKind: 'EXACT',
			key: `webgl/7/${deploymentId}/site/main.js`,
		})).toBe(true);
		expect(referenceIndex.referencesTarget({
			bucket: 'protected',
			targetKind: 'EXACT',
			key: 'images/original.png',
		})).toBe(false);
		expect(referenceIndex.referencesTarget({
			bucket: 'public',
			targetKind: 'EXACT',
			key: `webgl/7/${deploymentId}/outside/main.js`,
		})).toBe(false);
	});

	it('fails closed for a malformed WebGL pointer and handles prefix overlap', async () => {
		const logger = { error: vi.fn() };
		const inventory = await collectObjectReferences(
			referenceClient({ malformedWebgl: true }) as never,
			{ publicBucket: 'public', protectedBucket: 'protected' },
			logger,
		);
		expect(inventory.unsafeBuckets).toEqual(new Set(['public', 'protected']));
		const referenceIndex = createObjectReferenceIndex(inventory);
		expect(referenceIndex.referencesTarget({
			bucket: 'public',
			targetKind: 'EXACT',
			key: 'otherwise-unreferenced.bin',
		})).toBe(true);
		expect(referenceIndex.referencesTarget({
			bucket: 'protected',
			targetKind: 'EXACT',
			key: 'otherwise-unreferenced.zip',
		})).toBe(true);
		expect(logger.error).toHaveBeenCalledOnce();
		expect(targetsOverlap(
			{ bucket: 'public', targetKind: 'PREFIX', key: 'a/b/' },
			{ bucket: 'public', targetKind: 'PREFIX', key: 'a/b/c/' },
		)).toBe(true);
	});
});

function emptyReferenceModels() {
	return {
		asset: { findMany: vi.fn().mockResolvedValue([]) },
		exhibition: { findMany: vi.fn().mockResolvedValue([]) },
		project: { findMany: vi.fn().mockResolvedValue([]) },
		gameUploadSession: {
			findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
		},
		uploadIntent: { findMany: vi.fn().mockResolvedValue([]) },
	};
}

describe('conservative orphan reconciliation', () => {
	it('defaults to dry-run and never writes the queue', async () => {
		const startedAt = new Date('2026-08-11T12:00:00.000Z');
		expect(parseReconcileOptions([], startedAt)).toEqual({
			apply: false,
			olderThanMinutes: 60,
			startedAt,
		});
		const models = emptyReferenceModels();
		const orphanUpsert = vi.fn();
		const prisma = {
			...models,
			orphanObject: {
				upsert: orphanUpsert,
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
				findUniqueOrThrow: vi.fn().mockResolvedValue({}),
			},
			$queryRaw: vi.fn(),
		};
		const storage = {
			listObjects: vi.fn(async (bucket: string) => bucket === 'public' ? [
				{ key: 'old.bin', lastModified: new Date('2026-08-11T10:00:00.000Z') },
				{ key: 'recent.bin', lastModified: new Date('2026-08-11T11:30:00.000Z') },
				{ key: 'unknown.bin' },
			] : []),
		} as unknown as ObjectStorage;

		await expect(reconcileObjects({
			prisma: prisma as never,
			storage,
			publicBucket: 'public',
			protectedBucket: 'protected',
			options: parseReconcileOptions([], startedAt),
			logger: { log: vi.fn(), error: vi.fn() },
		})).resolves.toEqual({ scanned: 3, eligible: 1, enqueued: 0, skippedUnknownAge: 1 });
		expect(orphanUpsert).not.toHaveBeenCalled();
	});

	it('requires --apply and respects live prefix references and the age fence', async () => {
		const startedAt = new Date('2026-08-11T12:00:00.000Z');
		const models = emptyReferenceModels();
		models.project.findMany.mockResolvedValue([{
			id: 7,
			webglEntryKey: `webgl/7/${deploymentId}/site/index.html`,
		}]);
		const orphanUpsert = vi.fn().mockResolvedValue({});
		const prisma = {
			...models,
			orphanObject: {
				upsert: orphanUpsert,
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
				findUniqueOrThrow: vi.fn().mockResolvedValue({}),
			},
			$queryRaw: vi.fn(),
		};
		const storage = {
			listObjects: vi.fn(async (bucket: string) => bucket === 'public' ? [
				{
					key: `webgl/7/${deploymentId}/site/main.js`,
					lastModified: new Date('2026-08-11T09:00:00.000Z'),
				},
				{ key: 'orphan.bin', lastModified: new Date('2026-08-11T09:00:00.000Z') },
			] : []),
		} as unknown as ObjectStorage;

		await expect(reconcileObjects({
			prisma: prisma as never,
			storage,
			publicBucket: 'public',
			protectedBucket: 'protected',
			options: parseReconcileOptions(['--apply'], startedAt),
			logger: { log: vi.fn(), error: vi.fn() },
		})).resolves.toMatchObject({ eligible: 1, enqueued: 1 });
		expect(orphanUpsert).toHaveBeenCalledWith(expect.objectContaining({
			create: expect.objectContaining({ storageKey: 'orphan.bin', targetKind: 'EXACT' }),
		}));
		expect(orphanUpsert).not.toHaveBeenCalledWith(expect.objectContaining({
			create: expect.objectContaining({
				storageKey: `webgl/7/${deploymentId}/site/main.js`,
			}),
		}));
	});

	it('reuses one reference index for every reconciled object lookup', async () => {
		const startedAt = new Date('2026-08-11T12:00:00.000Z');
		const models = emptyReferenceModels();
		models.asset.findMany.mockResolvedValue([{
			id: 1,
			storageKey: 'live.png',
			playbackStorageKey: null,
			isPublic: true,
			card480Height: null,
			display960Height: null,
		}]);
		models.project.findMany.mockResolvedValue([{
			id: 7,
			webglEntryKey: `webgl/7/${deploymentId}/site/index.html`,
		}]);
		const orphanUpsert = vi.fn().mockResolvedValue({});
		const prisma = {
			...models,
			orphanObject: {
				upsert: orphanUpsert,
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
				findUniqueOrThrow: vi.fn().mockResolvedValue({}),
			},
			$queryRaw: vi.fn(),
		};
		const storage = {
			listObjects: vi.fn(async (bucket: string) => bucket === 'public' ? [
				{ key: 'live.png', lastModified: new Date('2026-08-11T09:00:00.000Z') },
				{ key: `webgl/7/${deploymentId}/site/main.js`, lastModified: new Date('2026-08-11T09:00:00.000Z') },
				{ key: 'orphan-public.bin', lastModified: new Date('2026-08-11T09:00:00.000Z') },
			] : [
				{ key: 'orphan-protected.bin', lastModified: new Date('2026-08-11T09:00:00.000Z') },
			]),
		} as unknown as ObjectStorage;
		const indexCreationsBefore = referenceResolverMocks.createObjectReferenceIndex.mock.calls.length;
		const indexesBefore = referenceResolverMocks.createdIndexes.length;

		await expect(reconcileObjects({
			prisma: prisma as never,
			storage,
			publicBucket: 'public',
			protectedBucket: 'protected',
			options: parseReconcileOptions(['--apply'], startedAt),
			logger: { log: vi.fn(), error: vi.fn() },
		})).resolves.toEqual({ scanned: 4, eligible: 2, enqueued: 2, skippedUnknownAge: 0 });

		expect(referenceResolverMocks.createObjectReferenceIndex).toHaveBeenCalledTimes(
			indexCreationsBefore + 1,
		);
		expect(referenceResolverMocks.createdIndexes[indexesBefore]!.referencesTarget)
			.toHaveBeenCalledTimes(4);
		expect(orphanUpsert).toHaveBeenCalledTimes(2);
		expect(orphanUpsert).toHaveBeenCalledWith(expect.objectContaining({
			create: expect.objectContaining({ storageKey: 'orphan-public.bin' }),
		}));
		expect(orphanUpsert).toHaveBeenCalledWith(expect.objectContaining({
			create: expect.objectContaining({ storageKey: 'orphan-protected.bin' }),
		}));
	});
});
