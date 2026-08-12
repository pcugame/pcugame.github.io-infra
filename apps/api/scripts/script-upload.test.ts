import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	AppLogger,
	FileSystem,
} from '../src/application/ports.js';
import type {
	SavedUpload,
	UploadPipelinePort,
} from '../src/application/upload-ports.js';
import type {
	Prisma,
	PrismaClient,
} from '../src/generated/prisma/client.js';
import { createNodeFileSystem } from '../src/infrastructure/production-ports.js';
import {
	createScriptAsset,
	runScriptUploadItem,
	type ScriptUploadItemResources,
} from './script-upload.js';
import { doImport } from './bulk-import.js';

const cleanupDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(cleanupDirectories.splice(0).map((directory) => (
		fsp.rm(directory, { recursive: true, force: true })
	)));
});

function logger(): AppLogger {
	const value = {
		child: () => value,
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};
	return value;
}

async function sourceFile(name: string, contents: string): Promise<{
	directory: string;
	path: string;
}> {
	const directory = await fsp.mkdtemp(join(tmpdir(), 'script-upload-test-'));
	cleanupDirectories.push(directory);
	const path = join(directory, name);
	await fsp.writeFile(path, contents);
	return { directory, path };
}

function uploadFor(kind: 'POSTER' | 'VIDEO'): SavedUpload {
	if (kind === 'VIDEO') {
		return {
			kind,
			storageKey: 'video-original.mp4',
			playbackStorageKey: 'video-playback.mp4',
			mimeType: 'video/quicktime',
			playbackMimeType: 'video/mp4',
			sizeBytes: 700,
			playbackSizeBytes: 500,
			playbackStatus: 'READY',
			playbackError: '',
			originalName: 'trailer.mov',
			uploadIntentIds: ['video-original-intent', 'video-playback-intent'],
		};
	}
	return {
		kind,
		storageKey: 'poster-original.webp',
		mimeType: 'image/webp',
		sizeBytes: 1_000,
		width: 1_200,
		height: 800,
		originalName: 'poster.png',
		renditions: [
			{
				profile: 'CARD_480',
				storageKey: 'poster-card.webp',
				sourceStorageKey: 'poster-original.webp',
				width: 480,
				height: 320,
				mimeType: 'image/webp',
				sizeBytes: 300,
			},
			{
				profile: 'DISPLAY_960',
				storageKey: 'poster-display.webp',
				sourceStorageKey: 'poster-original.webp',
				width: 960,
				height: 640,
				mimeType: 'image/webp',
				sizeBytes: 600,
			},
		],
		uploadIntentIds: ['poster-original-intent', 'poster-card-intent', 'poster-display-intent'],
	};
}

function pipelineHarness(options: { failProcessing?: Error; failOnCall?: number } = {}) {
	const stagedPaths: string[] = [];
	let processCount = 0;
	const rollbackCommitted = vi.fn(async () => undefined);
	const cleanupTemp = vi.fn(async () => {
		await Promise.all(stagedPaths.map((path) => fsp.unlink(path).catch(() => undefined)));
	});
	const processFile = vi.fn(async (path: string, kind: 'POSTER' | 'VIDEO') => {
		processCount++;
		if (options.failProcessing && processCount === (options.failOnCall ?? 1)) {
			throw options.failProcessing;
		}
		await fsp.access(path);
		return uploadFor(kind);
	});
	const pipeline: UploadPipelinePort = {
		setOwner: vi.fn(),
		trackTempFile(path) {
			stagedPaths.push(path);
		},
		processFile,
		rollbackCommitted,
		cleanupTemp,
	};
	return { pipeline, stagedPaths, processFile, rollbackCommitted, cleanupTemp };
}

function transactionHarness() {
	let insideTransaction = false;
	let nextAssetId = 10;
	const assetCreate = vi.fn(async (input: unknown) => {
		expect(insideTransaction).toBe(true);
		return { id: nextAssetId++, input };
	});
	const renditionCreateMany = vi.fn(async (input: unknown) => {
		expect(insideTransaction).toBe(true);
		return { count: 2, input };
	});
	const intentFindMany = vi.fn(async (input: {
		where: { id: { in: string[] } };
	}) => {
		expect(insideTransaction).toBe(true);
		return input.where.id.in.map((id) => ({
			id,
			bucket: id.startsWith('video') ? 'protected' : 'public',
			storageKey: `${id}.object`,
		}));
	});
	const intentUpdateMany = vi.fn(async (input: {
		where: { id: { in: string[] } };
	}) => {
		expect(insideTransaction).toBe(true);
		return { count: input.where.id.in.length };
	});
	const tx = {
		asset: { create: assetCreate },
		imageRendition: { createMany: renditionCreateMany },
		uploadIntent: { findMany: intentFindMany, updateMany: intentUpdateMany },
		$queryRaw: vi.fn(async () => {
			expect(insideTransaction).toBe(true);
			return [];
		}),
	} as unknown as Prisma.TransactionClient;
	const transaction = vi.fn(async <T>(
		work: (client: Prisma.TransactionClient) => Promise<T>,
	): Promise<T> => {
		insideTransaction = true;
		try {
			return await work(tx);
		} finally {
			insideTransaction = false;
		}
	});
	const prisma = { $transaction: transaction } as unknown as PrismaClient;
	return {
		prisma,
		assetCreate,
		renditionCreateMany,
		intentFindMany,
		intentUpdateMany,
		transaction,
	};
}

function resources(
	fileSystem: FileSystem,
	prisma: PrismaClient,
	pipeline: UploadPipelinePort,
): ScriptUploadItemResources {
	let id = 0;
	return {
		fileSystem,
		prisma,
		ids: { next: () => `stage-${++id}` },
		logger: logger(),
		createUploadPipeline: () => pipeline,
	};
}

describe('administrative script upload lifecycle', () => {
	it('persists dimensions, renditions, protected playback, and every intent in one transaction', async () => {
		const poster = await sourceFile('poster.png', 'poster-source');
		const video = await sourceFile('trailer.mov', 'video-source');
		const pipeline = pipelineHarness();
		const database = transactionHarness();
		const result = await runScriptUploadItem(
			resources(createNodeFileSystem(), database.prisma, pipeline.pipeline),
			{ projectId: 7, exhibitionId: 3 },
			[
				{ kind: 'POSTER', filePath: poster.path, originalName: 'poster.png' },
				{ kind: 'VIDEO', filePath: video.path, originalName: 'trailer.mov' },
			],
			async (tx, uploads) => {
				for (const upload of uploads) await createScriptAsset(tx, 7, upload);
				return 'committed';
			},
		);

		expect(result.result).toBe('committed');
		expect(pipeline.pipeline.setOwner).toHaveBeenCalledWith({
			projectId: 7,
			exhibitionId: 3,
		});
		expect(database.transaction).toHaveBeenCalledOnce();
		expect(database.assetCreate).toHaveBeenCalledTimes(2);
		expect(database.assetCreate.mock.calls[0]?.[0]).toMatchObject({
			data: {
				kind: 'POSTER',
				width: 1200,
				height: 800,
				isPublic: true,
			},
		});
		expect(database.assetCreate.mock.calls[1]?.[0]).toMatchObject({
			data: {
				kind: 'VIDEO',
				playbackStorageKey: 'video-playback.mp4',
				playbackMimeType: 'video/mp4',
				playbackStatus: 'READY',
				isPublic: false,
			},
		});
		expect(database.renditionCreateMany).toHaveBeenCalledWith({
			data: expect.arrayContaining([
				expect.objectContaining({
					profile: 'CARD_480',
					sourceStorageKey: 'poster-original.webp',
					width: 480,
				}),
				expect.objectContaining({
					profile: 'DISPLAY_960',
					width: 960,
				}),
			]),
		});
		const allIntentIds = [
			'poster-original-intent',
			'poster-card-intent',
			'poster-display-intent',
			'video-original-intent',
			'video-playback-intent',
		];
		expect(database.intentFindMany).toHaveBeenCalledWith(expect.objectContaining({
			where: expect.objectContaining({ id: { in: allIntentIds } }),
		}));
		expect(database.intentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
			where: expect.objectContaining({ id: { in: allIntentIds } }),
			data: expect.objectContaining({ state: 'COMMITTED' }),
		}));
		expect(pipeline.rollbackCommitted).not.toHaveBeenCalled();
		expect(pipeline.cleanupTemp).toHaveBeenCalledOnce();
		await expect(fsp.readFile(poster.path, 'utf8')).resolves.toBe('poster-source');
		await expect(fsp.readFile(video.path, 'utf8')).resolves.toBe('video-source');
		await Promise.all(pipeline.stagedPaths.map((path) => (
			expect(fsp.access(path)).rejects.toThrow()
		)));
	});

	it('rolls back the whole item and cleans staging when upload processing fails', async () => {
		const firstSource = await sourceFile('poster.png', 'first-source-preserved');
		const secondSource = await sourceFile('poster-2.png', 'second-source-preserved');
		const uploadError = new Error('rendition PUT failed');
		const pipeline = pipelineHarness({ failProcessing: uploadError, failOnCall: 2 });
		const database = transactionHarness();

		await expect(runScriptUploadItem(
			resources(createNodeFileSystem(), database.prisma, pipeline.pipeline),
			{ projectId: 7 },
			[
				{ kind: 'POSTER', filePath: firstSource.path, originalName: 'poster.png' },
				{ kind: 'POSTER', filePath: secondSource.path, originalName: 'poster-2.png' },
			],
			async () => undefined,
		)).rejects.toBe(uploadError);

		expect(database.transaction).not.toHaveBeenCalled();
		expect(pipeline.processFile).toHaveBeenCalledTimes(2);
		expect(pipeline.rollbackCommitted).toHaveBeenCalledOnce();
		expect(pipeline.cleanupTemp).toHaveBeenCalledOnce();
		await expect(fsp.readFile(firstSource.path, 'utf8')).resolves.toBe('first-source-preserved');
		await expect(fsp.readFile(secondSource.path, 'utf8')).resolves.toBe('second-source-preserved');
		await Promise.all(pipeline.stagedPaths.map((path) => (
			expect(fsp.access(path)).rejects.toThrow()
		)));
	});

	it('rolls back uploaded bundles when the owner transaction fails', async () => {
		const source = await sourceFile('poster.png', 'source-preserved');
		const databaseError = new Error('owner DB transaction failed');
		const pipeline = pipelineHarness();
		const database = transactionHarness();

		await expect(runScriptUploadItem(
			resources(createNodeFileSystem(), database.prisma, pipeline.pipeline),
			{ projectId: 7 },
			[{ kind: 'POSTER', filePath: source.path, originalName: 'poster.png' }],
			async () => {
				throw databaseError;
			},
		)).rejects.toBe(databaseError);

		expect(database.transaction).toHaveBeenCalledOnce();
		expect(database.intentUpdateMany).not.toHaveBeenCalled();
		expect(pipeline.rollbackCommitted).toHaveBeenCalledOnce();
		expect(pipeline.cleanupTemp).toHaveBeenCalledOnce();
		await expect(fsp.readFile(source.path, 'utf8')).resolves.toBe('source-preserved');
		await expect(fsp.access(pipeline.stagedPaths[0]!)).rejects.toThrow();
	});

	it('keeps bulk-import dry-run free of DB, storage, and pipeline mutations', async () => {
		const assetRoot = await fsp.mkdtemp(join(tmpdir(), 'script-assets-dry-run-'));
		const legacyDir = await fsp.mkdtemp(join(tmpdir(), 'script-legacy-dry-run-'));
		cleanupDirectories.push(assetRoot, legacyDir);
		await fsp.writeFile(
			join(legacyDir, 'legacy_example_2024_projects.json'),
			JSON.stringify([{
				title: 'Dry Run Project',
				studentIds: ['20240001'],
				names: ['Dry Runner'],
			}]),
		);
		const userUpsert = vi.fn();
		const exhibitionUpsert = vi.fn();
		const projectCreate = vi.fn();
		const createUploadPipeline = vi.fn();
		const prisma = {
			user: { upsert: userUpsert },
			exhibition: {
				findUnique: vi.fn(async () => null),
				upsert: exhibitionUpsert,
			},
			project: {
				findFirst: vi.fn(),
				findUnique: vi.fn(),
				create: projectCreate,
			},
		} as unknown as PrismaClient;
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

		try {
			await doImport({
				prisma,
				fileSystem: createNodeFileSystem(),
				ids: { next: () => 'unused' },
				logger: logger(),
				createUploadPipeline,
			}, {
				assetRoot,
				legacyDir,
				dryRun: true,
			});
		} finally {
			log.mockRestore();
		}

		expect(userUpsert).not.toHaveBeenCalled();
		expect(exhibitionUpsert).not.toHaveBeenCalled();
		expect(projectCreate).not.toHaveBeenCalled();
		expect(createUploadPipeline).not.toHaveBeenCalled();
	});
});
