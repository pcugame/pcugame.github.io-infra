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
import { createOrphanRepository } from '../modules/orphan/repository.js';

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

	it('uses the canonical current WebGL identity and ignores a stale legacy fallback pointer', async () => {
		const canonicalDeploymentId = '22222222-2222-4222-8222-222222222222';
		const client = referenceClient();
		client.project.findMany.mockResolvedValue([{
			id: 7,
			webglEntryKey: `webgl/7/${deploymentId}/site/index.html`,
			currentWebglDeploymentId: canonicalDeploymentId,
			currentWebglDeployment: {
				id: canonicalDeploymentId,
				state: 'READY',
				publicBucket: 'public',
				publicPrefix: `webgl/7/${canonicalDeploymentId}/site/`,
				entryObjectKey: `webgl/7/${canonicalDeploymentId}/site/index.html`,
				sourceRepresentation: {
					id: 'webgl-source-representation',
					state: 'READY',
					bucket: 'protected',
					objectKey: `webgl/7/${canonicalDeploymentId}/source.zip`,
				},
			},
		}]);
		const inventory = await collectObjectReferences(
			client as never,
			{ publicBucket: 'public', protectedBucket: 'protected' },
			{ error: vi.fn() },
		);

		expect(inventory.references).toEqual(expect.arrayContaining([
			expect.objectContaining({
				bucket: 'public', targetKind: 'PREFIX',
				key: `webgl/7/${canonicalDeploymentId}/site/`,
			}),
			expect.objectContaining({
				bucket: 'protected', targetKind: 'EXACT',
				key: `webgl/7/${canonicalDeploymentId}/source.zip`,
			}),
		]));
		expect(inventory.references).not.toContainEqual(expect.objectContaining({
			key: `webgl/7/${deploymentId}/site/`,
		}));
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
	it('parses only unique, well-formed exact targets', () => {
		const startedAt = new Date('2026-08-11T12:00:00.000Z');
		expect(parseReconcileOptions([
			'--exact-target=public:old.bin',
			'--exact-target=protected:key:with:colon.bin',
		], startedAt)).toMatchObject({
			exactTargets: [
				{ bucket: 'public', key: 'old.bin' },
				{ bucket: 'protected', key: 'key:with:colon.bin' },
			],
		});
		for (const argument of [
			'--exact-target',
			'--exact-target=public',
			'--exact-target=:old.bin',
			'--exact-target=public:',
			'--exact-target=public:old.bin',
			'--exact-target=public:old.bin',
		]) {
			const args = argument === '--exact-target=public:old.bin'
				? [argument, argument]
				: [argument];
			expect(() => parseReconcileOptions(args, startedAt)).toThrow();
		}
		for (const argument of ['--older-than-minutes=', '--older-than-minutes=   ']) {
			expect(() => parseReconcileOptions([argument], startedAt)).toThrow(
				'--older-than-minutes must be a non-negative number',
			);
		}
	});

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
			$queryRaw: vi.fn().mockResolvedValue([]),
		};
		const storage = {
			listObjects: vi.fn(async (bucket: string) => bucket === 'public' ? [
				{ key: 'old.bin', lastModified: new Date('2026-08-11T10:00:00.000Z') },
				{ key: 'recent.bin', lastModified: new Date('2026-08-11T11:30:00.000Z') },
				{ key: 'unknown.bin' },
				{ key: 'invalid-date.bin', lastModified: new Date('invalid') },
			] : []),
		} as unknown as ObjectStorage;

		await expect(reconcileObjects({
			prisma: prisma as never,
			storage,
			publicBucket: 'public',
			protectedBucket: 'protected',
			options: parseReconcileOptions([], startedAt),
			logger: { log: vi.fn(), error: vi.fn() },
		})).resolves.toEqual({ scanned: 4, eligible: 1, enqueued: 0, skippedUnknownAge: 2 });
		expect(orphanUpsert).not.toHaveBeenCalled();
	});

	it('rejects an age-fence timestamp overflow before inventory or storage access', async () => {
		const models = emptyReferenceModels();
		const storage = { listObjects: vi.fn(), head: vi.fn() } as unknown as ObjectStorage;
		await expect(reconcileObjects({
			prisma: { ...models } as never,
			storage,
			publicBucket: 'public',
			protectedBucket: 'protected',
			options: parseReconcileOptions([`--older-than-minutes=${Number.MAX_VALUE}`]),
			logger: { log: vi.fn(), error: vi.fn() },
		})).rejects.toThrow('invalid age fence');
		expect(models.asset.findMany).not.toHaveBeenCalled();
		expect(storage.listObjects).not.toHaveBeenCalled();
		expect(storage.head).not.toHaveBeenCalled();
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
			$queryRaw: vi.fn().mockResolvedValue([]),
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
			$queryRaw: vi.fn().mockResolvedValue([]),
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

	it('rearms only an inactive exact live-reference cancellation with HEAD, never LIST', async () => {
		const startedAt = new Date('2026-08-11T12:00:00.000Z');
		const models = emptyReferenceModels();
		models.asset.findMany.mockResolvedValue([{
			id: 1,
			representations: [{ id: 'live', role: 'ORIGINAL', bucket: 'public', objectKey: 'live.bin' }],
		}]);
		const exactCancellation = {
			state: 'CANCELLED',
			cancelReason: 'live-reference-detected',
			targetKind: 'EXACT',
		};
		const rows = new Map<string, typeof exactCancellation | undefined>([
			['public\0live.bin', exactCancellation],
			['public\0recent.bin', exactCancellation],
			['public\0unknown.bin', exactCancellation],
			['public\0old.bin', exactCancellation],
			['protected\0missing.bin', exactCancellation],
			['public\0not-cancelled.bin', {
				state: 'PENDING', cancelReason: null, targetKind: 'EXACT',
			} as never],
		]);
		const orphanUpsert = vi.fn().mockResolvedValue({});
		const findUnique = vi.fn(({ where }) => rows.get(
			`${where.orphan_bucket_storage_key.bucket}\0${where.orphan_bucket_storage_key.storageKey}`,
		));
		const prisma = {
			...models,
			orphanObject: {
				upsert: orphanUpsert,
				findUnique,
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
				findUniqueOrThrow: vi.fn().mockResolvedValue({}),
			},
			$queryRaw: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([{ id: 1 }]),
		};
		const storage = {
			head: vi.fn(async (_bucket: string, key: string) => ({
				'live.bin': { size: 1, contentType: 'application/octet-stream', lastModified: new Date('2026-08-11T09:00:00.000Z') },
				'recent.bin': { size: 1, contentType: 'application/octet-stream', lastModified: new Date('2026-08-11T11:30:00.000Z') },
				'unknown.bin': { size: 1, contentType: 'application/octet-stream' },
				'old.bin': { size: 1, contentType: 'application/octet-stream', lastModified: new Date('2026-08-11T09:00:00.000Z') },
			}[key] ?? null)),
			listObjects: vi.fn(),
			listKeys: vi.fn(),
			delete: vi.fn(),
		} as unknown as ObjectStorage;
		const logger = { log: vi.fn(), error: vi.fn() };

		await expect(reconcileObjects({
			prisma: prisma as never,
			storage,
			publicBucket: 'public',
			protectedBucket: 'protected',
			options: parseReconcileOptions([
				'--apply',
				'--exact-target=public:live.bin',
				'--exact-target=public:recent.bin',
				'--exact-target=public:unknown.bin',
				'--exact-target=public:old.bin',
				'--exact-target=protected:missing.bin',
				'--exact-target=public:not-cancelled.bin',
			], startedAt),
			logger,
		})).resolves.toEqual({ scanned: 6, eligible: 2, enqueued: 2, skippedUnknownAge: 1 });

		expect(storage.listObjects).not.toHaveBeenCalled();
		expect(storage.listKeys).not.toHaveBeenCalled();
		expect(storage.delete).not.toHaveBeenCalled();
		expect(storage.head).toHaveBeenCalledTimes(6);
		expect(orphanUpsert).not.toHaveBeenCalled();
		expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('skipped=live-reference-detected'));
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('skipped=recent'));
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('skipped=unknown-age'));
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('rearmed-absent'));
	});

	it('reports an exact rearm in dry-run without writing the outbox', async () => {
		const models = emptyReferenceModels();
		const orphanUpsert = vi.fn();
		const prisma = {
			...models,
			orphanObject: {
				upsert: orphanUpsert,
				findUnique: vi.fn().mockResolvedValue({
					state: 'CANCELLED',
					cancelReason: 'live-reference-detected',
					targetKind: 'EXACT',
				}),
				findUniqueOrThrow: vi.fn(),
			},
			$queryRaw: vi.fn().mockResolvedValue([]),
		};
		const storage = {
			head: vi.fn().mockResolvedValue({
				size: 1,
				contentType: 'application/octet-stream',
				lastModified: new Date('2026-08-11T09:00:00.000Z'),
			}),
			listObjects: vi.fn(),
		} as unknown as ObjectStorage;
		const logger = { log: vi.fn(), error: vi.fn() };

		await expect(reconcileObjects({
			prisma: prisma as never,
			storage,
			publicBucket: 'public',
			protectedBucket: 'protected',
			options: parseReconcileOptions(['--exact-target=public:old.bin'], new Date('2026-08-11T12:00:00.000Z')),
			logger,
		})).resolves.toEqual({ scanned: 1, eligible: 1, enqueued: 0, skippedUnknownAge: 0 });
		expect(orphanUpsert).not.toHaveBeenCalled();
		expect(storage.listObjects).not.toHaveBeenCalled();
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('would-rearm'));
	});

	it('does not count or report a rearm when the outbox row changes after preflight', async () => {
		const models = emptyReferenceModels();
		const orphanUpsert = vi.fn();
		const prisma = {
			...models,
			orphanObject: {
				upsert: orphanUpsert,
				findUnique: vi.fn().mockResolvedValue({
					state: 'CANCELLED',
					cancelReason: 'live-reference-detected',
					targetKind: 'EXACT',
				}),
				findUniqueOrThrow: vi.fn(),
			},
			// Simulates a concurrent writer changing the row before the conditional UPDATE.
			$queryRaw: vi.fn().mockResolvedValue([]),
		};
		const storage = {
			head: vi.fn().mockResolvedValue({
				size: 1,
				contentType: 'application/octet-stream',
				lastModified: new Date('2026-08-11T09:00:00.000Z'),
			}),
			listObjects: vi.fn(),
		} as unknown as ObjectStorage;
		const logger = { log: vi.fn(), error: vi.fn() };

		await expect(reconcileObjects({
			prisma: prisma as never,
			storage,
			publicBucket: 'public',
			protectedBucket: 'protected',
			options: parseReconcileOptions(['--apply', '--exact-target=public:old.bin'], new Date('2026-08-11T12:00:00.000Z')),
			logger,
		})).resolves.toEqual({ scanned: 1, eligible: 0, enqueued: 0, skippedUnknownAge: 0 });
		expect(orphanUpsert).not.toHaveBeenCalled();
		expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('skipped=outbox-state-changed'));
	});

	it('uses an atomic conditional update for exact recovery without creating a row', async () => {
		const orphanObjectUpsert = vi.fn();
		const queryRaw = vi.fn().mockResolvedValue([]);
		const repository = createOrphanRepository({
			orphanObject: { upsert: orphanObjectUpsert },
			$queryRaw: queryRaw as never,
		} as never);

		await expect(repository.upsertOrphan(
			'public',
			'old.bin',
			'reconcile',
			'EXACT',
			new Date('2026-08-11T12:00:00.000Z'),
			{ requireCancelledLiveReference: true },
		)).resolves.toEqual({ rearmed: false });
		expect(orphanObjectUpsert).not.toHaveBeenCalled();
		expect(queryRaw).toHaveBeenCalledOnce();
	});

	it('rejects an exact target outside the configured buckets before storage access', async () => {
		const models = emptyReferenceModels();
		const storage = { head: vi.fn(), listObjects: vi.fn() } as unknown as ObjectStorage;
		await expect(reconcileObjects({
			prisma: {
				...models,
				orphanObject: { findUnique: vi.fn() },
			} as never,
			storage,
			publicBucket: 'public',
			protectedBucket: 'protected',
			options: parseReconcileOptions(['--exact-target=other:old.bin']),
			logger: { log: vi.fn(), error: vi.fn() },
		})).rejects.toThrow('bucket is not configured');
		expect(storage.head).not.toHaveBeenCalled();
	});
});
