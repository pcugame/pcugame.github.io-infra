import { promises as fsp } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadPipelinePort } from '../application/upload-ports.js';
import { createProjectAssetService } from '../modules/admin/project/project-asset.service.js';
import { createProjectAssetUploadCoordinator } from '../modules/admin/project/project-asset-upload.adapter.js';
import { createNodeFileSystem } from '../infrastructure/production-ports.js';

const mocks = {
	createAsset: vi.fn(),
	replaceOrCreateReplaceableAsset: vi.fn(),
	findExhibitionById: vi.fn(),
	deleteOrQueue: vi.fn(),
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
	assetUrl: (key, kind) => `http://localhost:4000/api/assets/${kind === 'GAME' || kind === 'VIDEO' ? 'protected' : 'public'}/${key}`,
	bucketForKind: () => 'test-bucket',
	deleteOrQueue: mocks.deleteOrQueue,
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
			url: 'http://localhost:4000/api/assets/public/asset/image.png',
		});
		await expect(fsp.access(tempFile)).rejects.toThrow();
	});

	it('does not roll back a committed GAME replacement when old-object queueing fails', async () => {
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
		mocks.deleteOrQueue.mockRejectedValue(new Error('durable deletion unavailable'));

		await expect(projectAssetService.addAssetToProject(
			7,
			1,
			assetRequest('GAME', [zipHeader], 'game.zip'),
		)).resolves.toEqual({
			assetId: 321,
			url: 'http://localhost:4000/api/assets/protected/asset/new-game.zip',
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
		expect(mocks.logError).toHaveBeenCalledWith(
			expect.objectContaining({ assetId: 321, storageKey: 'asset/old-game.zip' }),
			'Post-commit asset cleanup failed; durable outbox retained',
		);
		startSpy.mockRestore();
	});
});
