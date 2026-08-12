import { Readable, Writable } from 'node:stream';
import { promises as nodeFileSystem } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import type { FileSystem } from '../application/ports.js';
import { createNodeFileSystem } from '../infrastructure/production-ports.js';
import {
	backfillImageRenditions,
	parseImageRenditionBackfillOptions,
} from '../modules/assets/image-rendition-backfill.js';
import { deriveImageRenditionStorageKey } from '../shared/responsive-image.js';

describe('image rendition backfill options', () => {
	it('defaults to dry-run and one worker', () => {
		expect(parseImageRenditionBackfillOptions([])).toEqual({
			apply: false,
			owner: 'all',
			concurrency: 1,
		});
	});

	it('parses owner-specific resume cursors and apply options', () => {
		expect(parseImageRenditionBackfillOptions([
			'--apply',
			'--limit=12',
			'--owner', 'asset',
			'--concurrency=4',
			'--after-asset-id', '30',
			'--after-exhibition-id=9',
		])).toEqual({
			apply: true,
			limit: 12,
			owner: 'asset',
			concurrency: 4,
			afterAssetId: 30,
			afterExhibitionId: 9,
		});
	});

	it('rejects unsafe concurrency and unknown options', () => {
		expect(() => parseImageRenditionBackfillOptions(['--concurrency=5']))
			.toThrow('--concurrency must be between 1 and 4');
		expect(() => parseImageRenditionBackfillOptions(['--surprise']))
			.toThrow('Unknown backfill option');
	});
});

function dryRunDependencies(input: {
	assets?: Array<Record<string, unknown>>;
	exhibitions?: Array<Record<string, unknown>>;
	stream?: () => Promise<{ body: Readable } | null>;
}) {
	const upload = vi.fn();
	const stream = vi.fn(input.stream ?? (async () => null));
	const transaction = vi.fn();
	const remove = vi.fn(async () => {});
	const fileSystem = {
		temporaryDirectory: () => '/tmp',
		stat: vi.fn(),
		access: vi.fn(),
		mkdir: vi.fn(),
		rename: vi.fn(),
		remove,
		readRange: vi.fn(),
		createReadStream: vi.fn(),
		createWriteStream: vi.fn(() => {
			const chunks: Buffer[] = [];
			return new (class extends Writable {
				_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
					chunks.push(Buffer.from(chunk));
					callback();
				}
			})();
		}),
	} as unknown as FileSystem;
	return {
		deps: {
			prisma: {
				asset: { findMany: vi.fn(async () => input.assets ?? []) },
				exhibition: { findMany: vi.fn(async () => input.exhibitions ?? []) },
				$transaction: transaction,
			},
			storage: {
				stream,
				upload,
			},
			fileSystem,
			ids: { next: vi.fn(() => 'fixed-id') },
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			publicBucket: 'public',
			uploadIntents: {
				prepare: vi.fn(),
				markUploaded: vi.fn(),
				recordAmbiguousError: vi.fn(),
				isUncommitted: vi.fn(),
			},
			orphanDeletions: { deleteOrQueue: vi.fn() },
		} as never,
		upload,
		stream,
		transaction,
	};
}

type DryRunAsset = {
	id: number;
	projectId: number;
	kind: 'IMAGE' | 'POSTER' | 'THUMBNAIL';
	storageKey: string;
	width: number | null;
	height: number | null;
	card480Height: number | null;
	display960Height: number | null;
};

async function realDryRunHarness(input: {
	assets: DryRunAsset[];
	sources: ReadonlyMap<string, Buffer | null>;
	beforeStream?: (storageKey: string) => Promise<void>;
}) {
	const temporaryDirectory = await nodeFileSystem.mkdtemp(
		path.join(os.tmpdir(), 'image-backfill-dry-run-test-'),
	);
	const fileSystem = {
		...createNodeFileSystem(),
		temporaryDirectory: () => temporaryDirectory,
	};
	const stream = vi.fn(async (_bucket: string, storageKey: string) => {
		await input.beforeStream?.(storageKey);
		const source = input.sources.get(storageKey);
		return source ? { body: Readable.from([source]) } : null;
	});
	let idSequence = 0;
	return {
		temporaryDirectory,
		stream,
		deps: {
			prisma: {
				asset: { findMany: vi.fn(async () => input.assets) },
				exhibition: { findMany: vi.fn(async () => []) },
				$transaction: vi.fn(),
			},
			storage: { stream, upload: vi.fn() },
			fileSystem,
			ids: { next: () => `dry-run-${++idSequence}` },
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
			publicBucket: 'public',
			uploadIntents: {
				prepare: vi.fn(),
				markUploaded: vi.fn(),
				recordAmbiguousError: vi.fn(),
				isUncommitted: vi.fn(),
			},
			orphanDeletions: { deleteOrQueue: vi.fn() },
		} as never,
	};
}

async function imageSource(width: number, height: number, background = '#224466'): Promise<Buffer> {
	return sharp({
		create: { width, height, channels: 3, background },
	}).webp({ quality: 85 }).toBuffer();
}

describe('image rendition backfill dry-run', () => {
	it('reports already-complete items without storage or mutations', async () => {
		const harness = dryRunDependencies({
			assets: [{
				id: 5,
				projectId: 7,
				kind: 'IMAGE',
				storageKey: 'original.webp',
				width: 1200,
				height: 800,
				card480Height: 320,
				display960Height: 640,
			}],
		});

		await expect(backfillImageRenditions(harness.deps, {
			apply: false,
			owner: 'asset',
			concurrency: 1,
		})).resolves.toMatchObject({
			scanned: 1,
			alreadyComplete: 1,
			succeeded: 1,
			failed: 0,
			resumeAfterAssetId: 5,
		});
		expect(harness.upload).not.toHaveBeenCalled();
		expect(harness.transaction).not.toHaveBeenCalled();
	});

	it('counts a missing source, continues, and leaves the failed cursor unadvanced', async () => {
		const harness = dryRunDependencies({
			assets: [{
				id: 6,
				projectId: 7,
				kind: 'POSTER',
				storageKey: 'missing.webp',
				width: null,
				height: null,
				card480Height: null,
				display960Height: null,
			}],
		});

		await expect(backfillImageRenditions(harness.deps, {
			apply: false,
			owner: 'asset',
			concurrency: 2,
			afterAssetId: 5,
		})).resolves.toMatchObject({
			scanned: 1,
			metadataMissing: 1,
			sourceObjectMissing: 1,
			failed: 1,
			resumeAfterAssetId: 5,
			failures: [{ owner: 'asset', id: 6 }],
		});
		expect(harness.upload).not.toHaveBeenCalled();
		expect(harness.transaction).not.toHaveBeenCalled();
	});

	it('continues with the next item after one source is missing', async () => {
		const validSource = await imageSource(800, 400);
		const harness = await realDryRunHarness({
			assets: [{
				id: 6,
				projectId: 7,
				kind: 'IMAGE',
				storageKey: 'missing.webp',
				width: null,
				height: null,
				card480Height: null,
				display960Height: null,
			}, {
				id: 7,
				projectId: 7,
				kind: 'IMAGE',
				storageKey: 'valid.webp',
				width: null,
				height: null,
				card480Height: null,
				display960Height: null,
			}],
			sources: new Map([
				['missing.webp', null],
				['valid.webp', validSource],
			]),
		});

		try {
			await expect(backfillImageRenditions(harness.deps, {
				apply: false,
				owner: 'asset',
				concurrency: 1,
			})).resolves.toMatchObject({
				scanned: 2,
				succeeded: 1,
				failed: 1,
				sourceObjectMissing: 1,
				plannedCard480: 1,
				plannedDisplay960: 0,
				failures: [{ owner: 'asset', id: 6 }],
			});
			expect(harness.stream).toHaveBeenNthCalledWith(1, 'public', 'missing.webp');
			expect(harness.stream).toHaveBeenNthCalledWith(2, 'public', 'valid.webp');
			expect(await nodeFileSystem.readdir(harness.temporaryDirectory)).toEqual([]);
		} finally {
			await nodeFileSystem.rm(harness.temporaryDirectory, { recursive: true, force: true });
		}
	});

	it('runs more than one item concurrently when requested', async () => {
		const sources = new Map<string, Buffer | null>([
			['first.webp', await imageSource(800, 400, '#112233')],
			['second.webp', await imageSource(800, 400, '#334455')],
		]);
		let activeStreams = 0;
		let maxActiveStreams = 0;
		let release!: () => void;
		const releaseGate = new Promise<void>((resolve) => { release = resolve; });
		const harness = await realDryRunHarness({
			assets: ['first.webp', 'second.webp'].map((storageKey, index) => ({
				id: index + 1,
				projectId: 7,
				kind: 'IMAGE' as const,
				storageKey,
				width: null,
				height: null,
				card480Height: null,
				display960Height: null,
			})),
			sources,
			beforeStream: async () => {
				activeStreams += 1;
				maxActiveStreams = Math.max(maxActiveStreams, activeStreams);
				await releaseGate;
				activeStreams -= 1;
			},
		});

		try {
			const running = backfillImageRenditions(harness.deps, {
				apply: false,
				owner: 'asset',
				concurrency: 2,
			});
			await vi.waitFor(() => expect(maxActiveStreams).toBe(2));
			release();
			await expect(running).resolves.toMatchObject({
				scanned: 2,
				succeeded: 2,
				failed: 0,
			});
			expect(await nodeFileSystem.readdir(harness.temporaryDirectory)).toEqual([]);
		} finally {
			release();
			await nodeFileSystem.rm(harness.temporaryDirectory, { recursive: true, force: true });
		}
	});

	it('keeps a failed lower asset cursor blocked while the exhibition cursor advances', async () => {
		const harness = dryRunDependencies({
			assets: [{
				id: 6,
				projectId: 7,
				kind: 'IMAGE',
				storageKey: 'missing.webp',
				width: null,
				height: null,
				card480Height: null,
				display960Height: null,
			}, {
				id: 7,
				projectId: 7,
				kind: 'IMAGE',
				storageKey: 'complete-asset.webp',
				width: 400,
				height: 200,
				card480Height: null,
				display960Height: null,
			}],
			exhibitions: [{
				id: 3,
				posterStorageKey: 'complete-exhibition.webp',
				posterWidth: 400,
				posterHeight: 200,
				posterCard480Height: null,
				posterDisplay960Height: null,
			}],
		});

		await expect(backfillImageRenditions(harness.deps, {
			apply: false,
			owner: 'all',
			concurrency: 4,
			afterAssetId: 5,
			afterExhibitionId: 2,
		})).resolves.toMatchObject({
			failed: 1,
			succeeded: 2,
			resumeAfterAssetId: 5,
			resumeAfterExhibitionId: 3,
		});
	});
});

async function applyHarness(options: {
	sourceChanged?: boolean;
	uploadFailure?: Error;
	transactionFailure?: Error;
	sourceWidth?: number;
	sourceHeight?: number;
	assetWidth?: number | null;
	assetHeight?: number | null;
	card480Height?: number | null;
	display960Height?: number | null;
} = {}) {
	const temporaryDirectory = await nodeFileSystem.mkdtemp(path.join(os.tmpdir(), 'image-backfill-test-'));
	const nodeFiles = createNodeFileSystem();
	const streamLifecycle: Array<{
		type: 'close' | 'remove';
		filePath: string;
		body?: Readable;
	}> = [];
	const streamErrors: unknown[] = [];
	const fileSystem: FileSystem = {
		...nodeFiles,
		temporaryDirectory: () => temporaryDirectory,
		createReadStream(filePath) {
			const body = nodeFiles.createReadStream(filePath);
			body.on('error', (error) => streamErrors.push(error));
			body.once('close', () => streamLifecycle.push({ type: 'close', filePath, body }));
			return body;
		},
		async remove(filePath) {
			streamLifecycle.push({ type: 'remove', filePath });
			await nodeFiles.remove(filePath);
		},
	};
	const canonical = await sharp({
		create: {
			width: options.sourceWidth ?? 1_200,
			height: options.sourceHeight ?? 600,
			channels: 3,
			background: '#446688',
		},
	}).webp({ quality: 85 }).toBuffer();
	const assetRecord = {
		id: 5,
		projectId: 7,
		kind: 'IMAGE' as const,
		storageKey: 'source.webp',
		width: options.assetWidth ?? null,
		height: options.assetHeight ?? null,
		card480Height: options.card480Height ?? null,
		display960Height: options.display960Height ?? null,
	};
	let sequence = 0;
	const uploadedObjects = new Map<string, Buffer>();
	const uploadBodies: Readable[] = [];
	const intentById = new Map<string, { bucket: string; storageKey: string }>();
	const markUploaded = vi.fn(async () => {});
	const recordAmbiguousError = vi.fn(async () => {});
	const isUncommitted = vi.fn(async () => true);
	let rawCall = 0;
	const assetUpdate = vi.fn(async ({ data }: { data: {
		width: number;
		height: number;
		card480Height?: number;
		display960Height?: number;
	} }) => {
		assetRecord.width = data.width;
		assetRecord.height = data.height;
		if (data.card480Height !== undefined) assetRecord.card480Height = data.card480Height;
		if (data.display960Height !== undefined) assetRecord.display960Height = data.display960Height;
		return { id: 5 };
	});
	const outboxUpsert = vi.fn();
	const tx = {
		$queryRaw: vi.fn(async () => {
			rawCall++;
			if (rawCall === 1) return [{ id: 7 }];
			if (rawCall === 2) return [{
				storageKey: options.sourceChanged ? 'replacement.webp' : 'source.webp',
				status: 'READY',
				card480Height: assetRecord.card480Height,
				display960Height: assetRecord.display960Height,
			}];
			return [];
		}),
		asset: { update: assetUpdate },
		orphanObject: {
			upsert: outboxUpsert,
			updateMany: vi.fn(),
		},
		uploadIntent: {
			findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => (
				where.id.in.map((id) => ({ id, ...intentById.get(id)! }))
			)),
			updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => ({
				count: where.id.in.length,
			})),
		},
	};
	const rollback = vi.fn(async (
		_bucket: string,
		_storageKey: string,
		_reason?: string,
		_options?: { intentId?: string },
	) => {});
	const transaction = vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => {
		rawCall = 0;
		const result = await operation(tx);
		if (options.transactionFailure) throw options.transactionFailure;
		return result;
	});
	const stream = vi.fn(async () => ({ body: Readable.from([canonical]) }));
	const upload = vi.fn(async (_bucket: string, key: string, body: Readable) => {
		uploadBodies.push(body);
		if (options.uploadFailure) throw options.uploadFailure;
		const chunks: Buffer[] = [];
		for await (const chunk of body) chunks.push(Buffer.from(chunk));
		uploadedObjects.set(key, Buffer.concat(chunks));
	});
	const prepare = vi.fn(async (input: { bucket: string; storageKey: string }) => {
		const id = `intent-${intentById.size + 1}`;
		intentById.set(id, input);
		return id;
	});
	const loggerError = vi.fn();
	return {
		temporaryDirectory,
		assetRecord,
		rollback,
		uploadedObjects,
		uploadBodies,
		upload,
		stream,
		prepare,
		transaction,
		assetUpdate,
		outboxUpsert,
		loggerError,
		streamErrors,
		streamLifecycle: () => [...streamLifecycle],
		markUploaded,
		recordAmbiguousError,
		isUncommitted,
		deps: {
			prisma: {
				asset: { findMany: vi.fn(async () => [assetRecord]) },
				exhibition: { findMany: vi.fn(async () => []) },
				$transaction: transaction,
			},
			storage: {
				stream,
				upload,
			},
			fileSystem,
			ids: { next: vi.fn(() => `id-${++sequence}`) },
			logger: { info: vi.fn(), warn: vi.fn(), error: loggerError },
			publicBucket: 'public',
			uploadIntents: {
				prepare,
				markUploaded,
				recordAmbiguousError,
				isUncommitted,
			},
			orphanDeletions: { deleteOrQueue: rollback },
		} as never,
	};
}

describe('image rendition backfill apply', () => {
	it('rejects an underivable canonical key before opening source or rendition storage I/O', async () => {
		const sourceStorageKey = 'x'.repeat(1_020);
		const harness = dryRunDependencies({
			assets: [{
				id: 5,
				projectId: 7,
				kind: 'IMAGE',
				storageKey: sourceStorageKey,
				width: 1_200,
				height: 600,
				card480Height: null,
				display960Height: null,
			}],
		});

		await expect(backfillImageRenditions(harness.deps, {
			apply: true,
			owner: 'asset',
			concurrency: 1,
		})).resolves.toMatchObject({
			succeeded: 0,
			failed: 1,
			failures: [{ owner: 'asset', id: 5 }],
		});
		expect(harness.stream).not.toHaveBeenCalled();
		expect(harness.upload).not.toHaveBeenCalled();
		expect(harness.transaction).not.toHaveBeenCalled();
	});

	it('updates metadata only when the source is no wider than CARD_480', async () => {
		const harness = await applyHarness({ sourceWidth: 400, sourceHeight: 200 });
		try {
			await expect(backfillImageRenditions(harness.deps, {
				apply: true,
				owner: 'asset',
				concurrency: 1,
			})).resolves.toMatchObject({
				metadataMissing: 1,
				plannedCard480: 0,
				plannedDisplay960: 0,
				succeeded: 1,
				failed: 0,
			});
			expect(harness.assetRecord).toMatchObject({ width: 400, height: 200 });
			expect(harness.assetRecord).toMatchObject({
				card480Height: null,
				display960Height: null,
			});
			expect(harness.prepare).not.toHaveBeenCalled();
			expect(harness.upload).not.toHaveBeenCalled();
			expect(harness.transaction).toHaveBeenCalledOnce();
			expect(await nodeFileSystem.readdir(harness.temporaryDirectory)).toEqual([]);
		} finally {
			await nodeFileSystem.rm(harness.temporaryDirectory, { recursive: true, force: true });
		}
	});

	it('creates only CARD_480 for a source between 481 and 960 pixels wide', async () => {
		const harness = await applyHarness({ sourceWidth: 800, sourceHeight: 400 });
		try {
			await expect(backfillImageRenditions(harness.deps, {
				apply: true,
				owner: 'asset',
				concurrency: 1,
			})).resolves.toMatchObject({
				plannedCard480: 1,
				plannedDisplay960: 0,
				succeeded: 1,
				failed: 0,
			});
			expect(harness.uploadedObjects.size).toBe(1);
			expect(harness.assetUpdate).toHaveBeenCalledWith({
				where: { id: 5 },
				data: expect.objectContaining({ card480Height: 240 }),
				select: { id: true },
			});
			expect([...harness.uploadedObjects.keys()]).toEqual([
				deriveImageRenditionStorageKey('source.webp', 'CARD_480'),
			]);
			const uploaded = [...harness.uploadedObjects.values()][0]!;
			await expect(sharp(uploaded).metadata()).resolves.toMatchObject({ width: 480, height: 240 });
			for (const call of harness.upload.mock.calls) expect(call[1]).not.toBe('source.webp');
			expect(harness.stream).toHaveBeenCalledWith('public', 'source.webp');
		} finally {
			await nodeFileSystem.rm(harness.temporaryDirectory, { recursive: true, force: true });
		}
	});

	it('fills only DISPLAY_960 when CARD_480 is already current', async () => {
		const harness = await applyHarness({
			sourceWidth: 1_200,
			sourceHeight: 600,
			assetWidth: 1_200,
			assetHeight: 600,
			card480Height: 240,
		});
		try {
			await expect(backfillImageRenditions(harness.deps, {
				apply: true,
				owner: 'asset',
				concurrency: 1,
			})).resolves.toMatchObject({
				plannedCard480: 0,
				plannedDisplay960: 1,
				succeeded: 1,
				failed: 0,
			});
			expect(harness.uploadedObjects.size).toBe(1);
			expect(harness.assetRecord).toMatchObject({
				card480Height: 240,
				display960Height: 480,
			});
		} finally {
			await nodeFileSystem.rm(harness.temporaryDirectory, { recursive: true, force: true });
		}
	});

	it('does not read storage or mutate an already-complete item in apply mode', async () => {
		const harness = await applyHarness({
			assetWidth: 1_200,
			assetHeight: 600,
			card480Height: 240,
			display960Height: 480,
		});
		try {
			await expect(backfillImageRenditions(harness.deps, {
				apply: true,
				owner: 'asset',
				concurrency: 1,
			})).resolves.toMatchObject({
				alreadyComplete: 1,
				succeeded: 1,
				failed: 0,
			});
			expect(harness.stream).not.toHaveBeenCalled();
			expect(harness.prepare).not.toHaveBeenCalled();
			expect(harness.upload).not.toHaveBeenCalled();
			expect(harness.transaction).not.toHaveBeenCalled();
		} finally {
			await nodeFileSystem.rm(harness.temporaryDirectory, { recursive: true, force: true });
		}
	});

	it('uploads both missing profiles and commits dimensions, rows, and intents together', async () => {
		const harness = await applyHarness();
		try {
			await expect(backfillImageRenditions(harness.deps, {
				apply: true,
				owner: 'asset',
				concurrency: 1,
			})).resolves.toMatchObject({
				succeeded: 1,
				failed: 0,
				plannedCard480: 1,
				plannedDisplay960: 1,
			});
			expect(harness.uploadedObjects.size).toBe(2);
			expect(harness.prepare).toHaveBeenCalledTimes(2);
			expect(harness.markUploaded).toHaveBeenCalledTimes(2);
			for (let index = 0; index < 2; index += 1) {
				expect(harness.prepare.mock.invocationCallOrder[index])
					.toBeLessThan(harness.upload.mock.invocationCallOrder[index]!);
				expect(harness.upload.mock.invocationCallOrder[index])
					.toBeLessThan(harness.markUploaded.mock.invocationCallOrder[index]!);
			}
			expect(harness.assetRecord).toMatchObject({
				card480Height: 240,
				display960Height: 480,
			});
			expect([...harness.uploadedObjects.keys()].sort()).toEqual([
				deriveImageRenditionStorageKey('source.webp', 'CARD_480'),
				deriveImageRenditionStorageKey('source.webp', 'DISPLAY_960'),
			].sort());
			expect(harness.rollback).not.toHaveBeenCalled();
			expect(await nodeFileSystem.readdir(harness.temporaryDirectory)).toEqual([]);
		} finally {
			await nodeFileSystem.rm(harness.temporaryDirectory, { recursive: true, force: true });
		}
	});

	it('durably rolls back every uploaded rendition when the DB transaction fails', async () => {
		const transactionFailure = new Error('database commit failed');
		const harness = await applyHarness({ transactionFailure });
		try {
			await expect(backfillImageRenditions(harness.deps, {
				apply: true,
				owner: 'asset',
				concurrency: 1,
			})).resolves.toMatchObject({
				succeeded: 0,
				failed: 1,
				failures: [{ owner: 'asset', id: 5, error: transactionFailure.message }],
			});
			expect(harness.uploadedObjects.size).toBe(2);
			expect(harness.markUploaded).toHaveBeenCalledTimes(2);
			expect(harness.isUncommitted).toHaveBeenCalledTimes(2);
			expect(harness.rollback).toHaveBeenCalledTimes(2);
			const uploadedKeys = [...harness.uploadedObjects.keys()].sort();
			const rollbackKeys = harness.rollback.mock.calls.map((call) => call[1]).sort();
			expect(rollbackKeys).toEqual(uploadedKeys);
			expect(uploadedKeys).not.toContain('source.webp');
			expect(await nodeFileSystem.readdir(harness.temporaryDirectory)).toEqual([]);
		} finally {
			await nodeFileSystem.rm(harness.temporaryDirectory, { recursive: true, force: true });
		}
	});

	it('treats a successful partial run as complete when rerun', async () => {
		const harness = await applyHarness({
			sourceWidth: 1_200,
			sourceHeight: 600,
			assetWidth: 1_200,
			assetHeight: 600,
			card480Height: 240,
		});
		try {
			await expect(backfillImageRenditions(harness.deps, {
				apply: true,
				owner: 'asset',
				concurrency: 1,
			})).resolves.toMatchObject({
				plannedDisplay960: 1,
				succeeded: 1,
			});
			const firstUploadCount = harness.upload.mock.calls.length;
			const firstTransactionCount = harness.transaction.mock.calls.length;

			await expect(backfillImageRenditions(harness.deps, {
				apply: true,
				owner: 'asset',
				concurrency: 1,
				afterAssetId: 4,
			})).resolves.toMatchObject({
				alreadyComplete: 1,
				succeeded: 1,
				failed: 0,
				resumeAfterAssetId: 5,
			});
			expect(harness.upload).toHaveBeenCalledTimes(firstUploadCount);
			expect(harness.transaction).toHaveBeenCalledTimes(firstTransactionCount);
			expect(harness.stream).toHaveBeenCalledOnce();
		} finally {
			await nodeFileSystem.rm(harness.temporaryDirectory, { recursive: true, force: true });
		}
	});

	it('settles an immediately rejected rendition stream before temp cleanup and rollback', async () => {
		const uploadError = new Error('storage rejected before consuming rendition body');
		const harness = await applyHarness({ uploadFailure: uploadError });
		try {
			await expect(backfillImageRenditions(harness.deps, {
				apply: true,
				owner: 'asset',
				concurrency: 1,
			})).resolves.toMatchObject({
				succeeded: 0,
				failed: 1,
				failures: [{
					owner: 'asset',
					id: 5,
					error: uploadError.message,
				}],
			});

			const body = harness.uploadBodies[0];
			expect(body).toBeInstanceOf(Readable);
			expect(body?.destroyed).toBe(true);
			expect(body?.closed).toBe(true);
			const lifecycle = harness.streamLifecycle();
			const closeIndex = lifecycle.findIndex((event) => (
				event.type === 'close' && event.body === body
			));
			const bodyPath = lifecycle[closeIndex]?.filePath;
			const removeIndex = lifecycle.findIndex((event) => (
				event.type === 'remove' && event.filePath === bodyPath
			));
			expect(closeIndex).toBeGreaterThanOrEqual(0);
			expect(removeIndex).toBeGreaterThan(closeIndex);
			expect(harness.recordAmbiguousError).toHaveBeenCalledWith('intent-1', uploadError);
			expect(harness.markUploaded).not.toHaveBeenCalled();
			expect(harness.isUncommitted).toHaveBeenCalledWith('intent-1');
			expect(harness.rollback).toHaveBeenCalledOnce();

			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(harness.streamErrors).toEqual([]);
			expect(await nodeFileSystem.readdir(harness.temporaryDirectory)).toEqual([]);
		} finally {
			await nodeFileSystem.rm(harness.temporaryDirectory, { recursive: true, force: true });
		}
	});

	it('does not attach old-source outputs when the locked owner source changed', async () => {
		const harness = await applyHarness({ sourceChanged: true });
		try {
			await expect(backfillImageRenditions(harness.deps, {
				apply: true,
				owner: 'asset',
				concurrency: 2,
			})).resolves.toMatchObject({
				sourceChanged: 1,
				succeeded: 0,
				failed: 0,
			});
			expect(harness.assetUpdate).not.toHaveBeenCalled();
			expect(harness.rollback).toHaveBeenCalledTimes(2);
		} finally {
			await nodeFileSystem.rm(harness.temporaryDirectory, { recursive: true, force: true });
		}
	});
});
