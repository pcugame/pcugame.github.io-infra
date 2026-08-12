import { promises as fsp } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	SingleAssetUploadCoordinator,
	UploadPipelinePort,
} from '../application/upload-ports.js';
import { createProjectAssetService } from '../modules/admin/project/project-asset.service.js';
import { createProjectAssetUploadCoordinator } from '../modules/admin/project/project-asset-upload.adapter.js';
import { createNodeFileSystem } from '../infrastructure/production-ports.js';

const mocks = {
	createAsset: vi.fn(),
	replaceOrCreateReplaceableAsset: vi.fn(),
	findExhibitionById: vi.fn(),
	wakeDeletionWorker: vi.fn(),
	processFile: vi.fn(),
	rollbackCommitted: vi.fn(),
	logError: vi.fn(),
};

const MB = 1024 * 1024;
const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
let id = 0;
let trackedTempFiles: string[] = [];
let cleanupSizes: number[] = [];

function createFakePipeline(): UploadPipelinePort {
	return {
		trackTempFile(tmpPath) {
			trackedTempFiles.push(tmpPath);
		},
		processFile: mocks.processFile,
		rollbackCommitted: mocks.rollbackCommitted,
		async cleanupTemp() {
			for (const tmpPath of trackedTempFiles) {
				const stat = await fsp.stat(tmpPath).catch(() => null);
				if (stat) cleanupSizes.push(stat.size);
				await fsp.unlink(tmpPath).catch(() => undefined);
			}
		},
	};
}

const singleAssetUploadCoordinator = createProjectAssetUploadCoordinator({
	fileSystem: createNodeFileSystem(),
	ids: { next: () => `resource-guard-${++id}` },
	createPipeline: createFakePipeline,
});
const projectAssetService = createProjectAssetService({
	repository: {
		createAsset: mocks.createAsset,
		replaceOrCreateReplaceableAsset: mocks.replaceOrCreateReplaceableAsset,
		findExhibitionById: mocks.findExhibitionById,
	},
	uploadLimits: () => ({
		posterMaxBytes: MB,
		imageMaxBytes: MB,
		gameMaxBytes: 2 * MB,
		videoMaxBytes: MB,
		requestMaxBytes: 3 * MB,
		maxFiles: 20,
	}),
	uploadSlots: { acquire: vi.fn(), release: vi.fn() },
	uploadCoordinator: singleAssetUploadCoordinator,
	bucketForKind: () => 'test-bucket',
	wakeDeletionWorker: mocks.wakeDeletionWorker,
	logger: { error: mocks.logError },
});

function chunksWithHeader(header: Buffer, totalBytes: number, chunkBytes: number): Buffer[] {
	const chunks: Buffer[] = [];
	let remaining = totalBytes;
	const firstSize = Math.min(chunkBytes, remaining);
	chunks.push(Buffer.concat([header, Buffer.alloc(firstSize - header.length)]));
	remaining -= firstSize;
	while (remaining > 0) {
		const size = Math.min(chunkBytes, remaining);
		chunks.push(Buffer.alloc(size));
		remaining -= size;
	}
	return chunks;
}

function assetRequest(kind: string, chunks: Buffer[], filename: string, fileFirst = false) {
	const parts = (async function* multipartParts() {
		const filePart = {
			type: 'file' as const,
			fieldname: 'file',
			filename,
			file: Readable.from(chunks),
		};
		const kindPart = {
			type: 'field' as const,
			fieldname: 'kind',
			value: kind,
		};
		if (fileFirst) {
			yield filePart;
			yield kindPart;
			return;
		}
		yield kindPart;
		yield filePart;
	})();
	return {
		actor: { id: 1, role: 'OPERATOR' as const },
		parts,
	};
}

function firstTrackedTempFile(paths: string[]): string {
	expect(paths[0]).toBeDefined();
	return paths[0]!;
}

describe('project asset upload resource guards', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		trackedTempFiles = [];
		cleanupSizes = [];
		mocks.processFile.mockResolvedValue({
			storageKey: 'asset/image.png',
			mimeType: 'image/png',
			sizeBytes: 128,
			originalName: 'image.png',
			kind: 'IMAGE',
		});
		mocks.createAsset.mockResolvedValue({ id: 321 });
		mocks.findExhibitionById.mockResolvedValue({
			id: 1,
			year: 2026,
			title: '',
			isUploadEnabled: true,
		});
	});

	afterEach(async () => {
		await Promise.all(trackedTempFiles.map((tmpPath) => (
			fsp.unlink(tmpPath).catch(() => undefined)
		)));
	});

	it('requires the kind field before writing the single-asset file', async () => {
		await expect(
			projectAssetService.addAssetToProject(
				7,
				1,
				assetRequest('IMAGE', chunksWithHeader(pngHeader, 128, 128), 'image.png', true),
			),
		).rejects.toMatchObject({
			statusCode: 400,
		});

		expect(trackedTempFiles).toEqual([]);
		expect(mocks.processFile).not.toHaveBeenCalled();
	});

	it('rejects an unsafe filename before creating a temp file', async () => {
		await expect(
			projectAssetService.addAssetToProject(
				7,
				1,
				assetRequest('IMAGE', chunksWithHeader(pngHeader, 128, 128), '../image.png'),
			),
		).rejects.toMatchObject({
			statusCode: 400,
			code: 'INVALID_FILENAME',
		});

		expect(trackedTempFiles).toEqual([]);
		expect(mocks.processFile).not.toHaveBeenCalled();
	});

	it('rejects oversized IMAGE before temp storage grows toward the GAME limit', async () => {
		await expect(
			projectAssetService.addAssetToProject(
				7,
				1,
				assetRequest('IMAGE', chunksWithHeader(pngHeader, 2 * MB, 512 * 1024), 'image.png'),
			),
		).rejects.toMatchObject({
			statusCode: 413,
			code: 'PAYLOAD_TOO_LARGE',
		});

		expect(mocks.processFile).not.toHaveBeenCalled();
		expect(cleanupSizes[0]).toBeLessThanOrEqual(1 * MB);
		await expect(fsp.access(firstTrackedTempFile(trackedTempFiles))).rejects.toThrow();
	});

	it('rejects oversized GAME during temp write and cleans the temp file', async () => {
		await expect(
			projectAssetService.addAssetToProject(
				7,
				1,
				assetRequest('GAME', chunksWithHeader(zipHeader, 3 * MB, 512 * 1024), 'game.zip'),
			),
		).rejects.toMatchObject({
			statusCode: 413,
			code: 'PAYLOAD_TOO_LARGE',
		});

		expect(mocks.processFile).not.toHaveBeenCalled();
		expect(cleanupSizes[0]).toBeLessThanOrEqual(2 * MB);
		await expect(fsp.access(firstTrackedTempFile(trackedTempFiles))).rejects.toThrow();
	});

	it('keeps the normal single-asset upload flow working', async () => {
		const result = await projectAssetService.addAssetToProject(
			7,
			1,
			assetRequest('IMAGE', chunksWithHeader(pngHeader, 128, 128), 'image.png'),
		);

		const tempFile = firstTrackedTempFile(trackedTempFiles);
		expect(mocks.processFile).toHaveBeenCalledWith(tempFile, 'IMAGE', 'image.png');
		expect(mocks.createAsset).toHaveBeenCalledWith(expect.objectContaining({
			projectId: 7,
			kind: 'IMAGE',
			storageKey: 'asset/image.png',
		}));
		expect(result).toEqual({
			assetId: 321,
		});
		await expect(fsp.access(tempFile)).rejects.toThrow();
	});

	it('wakes durable deletion after a committed GAME replacement without rolling it back', async () => {
		const rollback = vi.fn();
		const cleanup = vi.fn();
		const startSpy = vi.spyOn(singleAssetUploadCoordinator, 'start').mockResolvedValue({
			savedFile: {
				storageKey: 'asset/new-game.zip',
				mimeType: 'application/zip',
				sizeBytes: 128,
				originalName: 'game.zip',
				kind: 'GAME',
			},
			rollback,
			cleanup,
		});
		mocks.replaceOrCreateReplaceableAsset.mockResolvedValue({
			assetId: 321,
			oldStorageKey: 'asset/old-game.zip',
			oldPlaybackStorageKey: null,
		});

		await expect(projectAssetService.addAssetToProject(
			7,
			1,
			assetRequest('GAME', [zipHeader], 'game.zip'),
		)).resolves.toEqual({
			assetId: 321,
		});

		expect(mocks.replaceOrCreateReplaceableAsset).toHaveBeenCalledWith(
			7,
			'GAME',
			expect.objectContaining({ storageKey: 'asset/new-game.zip' }),
			{
				bucket: 'test-bucket',
				reason: 'project-asset-replace-previous',
				playbackReason: 'project-asset-replace-previous-playback',
			},
		);
		expect(rollback).not.toHaveBeenCalled();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(mocks.wakeDeletionWorker).toHaveBeenCalledOnce();
		expect(mocks.logError).not.toHaveBeenCalled();
		startSpy.mockRestore();
	});

	it('normalizes a legacy idempotency result to the assetId-only response', async () => {
		const replayCoordinator: SingleAssetUploadCoordinator = {
			async start(_parts, _limits, _owner, beforeUpload) {
				await beforeUpload?.('legacy-request-hash');
				throw new Error('Expected the stored idempotency result to short-circuit the upload');
			},
		};
		const service = createProjectAssetService({
			repository: {
				createAsset: mocks.createAsset,
				replaceOrCreateReplaceableAsset: mocks.replaceOrCreateReplaceableAsset,
				findExhibitionById: mocks.findExhibitionById,
			},
			uploadLimits: () => ({
				posterMaxBytes: MB,
				imageMaxBytes: MB,
				gameMaxBytes: 2 * MB,
				videoMaxBytes: MB,
				requestMaxBytes: 3 * MB,
				maxFiles: 20,
			}),
			uploadSlots: { acquire: vi.fn(), release: vi.fn() },
			uploadCoordinator: replayCoordinator,
			bucketForKind: () => 'test-bucket',
			wakeDeletionWorker: mocks.wakeDeletionWorker,
			idempotency: {
				claim: vi.fn(async () => ({
					kind: 'succeeded' as const,
					result: {
						assetId: 456,
						url: 'https://legacy.example.test/uploaded.webp',
					},
				})),
				markFailed: vi.fn(),
			},
		});

		await expect(service.addAssetToProject(
			7,
			1,
			{
				...assetRequest('IMAGE', [pngHeader], 'image.png'),
				idempotencyKey: 'legacy-replay',
			},
		)).resolves.toEqual({ assetId: 456 });
		expect(mocks.createAsset).not.toHaveBeenCalled();
	});
});
