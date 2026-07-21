import { promises as fsp } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectAssetService } from '../modules/admin/project/project-asset.service.js';
import { singleAssetUploadCoordinator } from '../modules/admin/project/project-asset-upload.adapter.js';
import { UploadPipeline } from '../modules/assets/upload/index.js';

const mocks = {
	createAsset: vi.fn(),
	replaceOrCreateReplaceableAsset: vi.fn(),
	findExhibitionById: vi.fn(),
};

const MB = 1024 * 1024;
const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
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
	deleteOrQueue: vi.fn(),
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
	let trackedTempFiles: string[];
	let cleanupSizes: number[];
	let trackSpy: ReturnType<typeof vi.spyOn>;
	let cleanupSpy: ReturnType<typeof vi.spyOn>;
	let processSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		trackedTempFiles = [];
		cleanupSizes = [];

		const originalTrack = UploadPipeline.prototype.trackTempFile;
		const originalCleanup = UploadPipeline.prototype.cleanupTemp;
		trackSpy = vi.spyOn(UploadPipeline.prototype, 'trackTempFile').mockImplementation(function (this: UploadPipeline, tmpPath: string) {
			trackedTempFiles.push(tmpPath);
			return originalTrack.call(this, tmpPath);
		});
		cleanupSpy = vi.spyOn(UploadPipeline.prototype, 'cleanupTemp').mockImplementation(async function (this: UploadPipeline) {
			for (const tmpPath of trackedTempFiles) {
				const stat = await fsp.stat(tmpPath).catch(() => null);
				if (stat) cleanupSizes.push(stat.size);
			}
			return originalCleanup.call(this);
		});
		processSpy = vi.spyOn(UploadPipeline.prototype, 'processFile').mockResolvedValue({
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

	afterEach(() => {
		trackSpy.mockRestore();
		cleanupSpy.mockRestore();
		processSpy.mockRestore();
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
		expect(processSpy).not.toHaveBeenCalled();
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
		expect(processSpy).not.toHaveBeenCalled();
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

		expect(processSpy).not.toHaveBeenCalled();
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

		expect(processSpy).not.toHaveBeenCalled();
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
		expect(processSpy).toHaveBeenCalledWith(tempFile, 'IMAGE', 'image.png');
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
});
