import { Readable } from 'node:stream';
import { createWriteStream, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExportStatusResponseSchema } from '@pcu/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExportFileWriter } from '../modules/admin/export/file.adapter.js';
import {
	createExportProgressStore,
	createExportService,
} from '../modules/admin/export/service.js';

const mocks = {
	findProjectsWithAssets: vi.fn(),
	getObject: vi.fn(),
};

const tempDirs: string[] = [];
let exportService: ReturnType<typeof createExportService>;
let exportProgress: ReturnType<typeof createExportProgressStore>;
let fileSequence = 0;

describe('NAS WebGL export', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fileSequence = 0;
		exportProgress = createExportProgressStore();
		const fileWriter = createExportFileWriter({
			ids: { next: () => `test-${++fileSequence}` },
			getObject: mocks.getObject,
			createWriteStream,
			rename: fsp.rename,
			remove: fsp.unlink,
			logCleanupError: vi.fn(),
		});
		exportService = createExportService({
			findProjects: mocks.findProjectsWithAssets,
			async pathExists(path) {
				try {
					await fsp.access(path);
					return true;
				} catch {
					return false;
				}
			},
			ensureDirectory: (path) => fsp.mkdir(path, { recursive: true }).then(() => undefined),
			saveObject: fileWriter.saveObject,
			bucketForKind: () => 'bucket',
			protectedBucket: 'pcu-protected',
			now: () => 0,
			logWarn: vi.fn(),
			logError: vi.fn(),
		}, exportProgress);
	});
	afterEach(async () => {
		await exportService.close();
		exportProgress.close();
		await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
	});

	it('counts and dry-runs only the original ZIP at webgl/webgl.zip', async () => {
		mocks.findProjectsWithAssets.mockResolvedValueOnce([{
			id: 17,
			title: '작품',
			webglEntryKey: 'webgl/17/123e4567-e89b-42d3-a456-426614174000/site/index.html',
			webglSourceKey: 'webgl/17/223e4567-e89b-42d3-a456-426614174000/source.zip',
			exhibition: { year: 2026, title: '졸업전시' },
			members: [{ name: '학생', studentId: '20260001', sortOrder: 0 }],
			assets: [{
				id: 5,
				kind: 'GAME',
				storageKey: 'game-object.zip',
				originalName: 'game.zip',
				mimeType: 'application/zip',
				sizeBytes: 100n,
			}],
		}]);

		const result = await exportService.exportAssets({ outDir: '/mnt/nas', dryRun: true });
		expect(result.totalFiles).toBe(2);
		expect(result.paths).toEqual([
			'/mnt/nas/ExportedAssets/2026_졸업전시/작품_20260001학생/game.zip',
			'/mnt/nas/ExportedAssets/2026_졸업전시/작품_20260001학생/webgl/webgl.zip',
		]);
		expect(result.paths.some((path) => path.includes('/site/'))).toBe(false);
	});

	it('includes projects that only have a WebGL deployment', async () => {
		mocks.findProjectsWithAssets.mockResolvedValueOnce([{
			id: 18,
			title: '웹게임',
			webglEntryKey: 'webgl/18/123e4567-e89b-42d3-a456-426614174000/site/index.html',
			webglSourceKey: 'webgl/18/223e4567-e89b-42d3-a456-426614174000/source.zip',
			exhibition: { year: 2026, title: '' },
			members: [],
			assets: [],
		}]);
		const result = await exportService.exportAssets({ outDir: '/mnt/nas', dryRun: true });
		expect(result).toMatchObject({ projects: 1, totalFiles: 1, failed: 0 });
		expect(result.paths[0]).toBe('/mnt/nas/ExportedAssets/2026/웹게임/webgl/webgl.zip');
	});

	it('writes the original ZIP, reports WebGL progress, and skips an existing export', async () => {
		const sourceKey = 'webgl/19/123e4567-e89b-42d3-a456-426614174000/source.zip';
		mocks.findProjectsWithAssets.mockResolvedValue([{
			id: 19,
			title: '실제내보내기',
			webglEntryKey: 'webgl/19/123e4567-e89b-42d3-a456-426614174000/site/index.html',
			webglSourceKey: sourceKey,
			exhibition: { year: 2026, title: '전시' },
			members: [],
			assets: [],
		}]);
		const captured = {
			progress: null as ReturnType<typeof exportService.getExportProgress>,
		};
		mocks.getObject.mockImplementation(async () => {
			captured.progress = exportService.getExportProgress();
			return Readable.from([Buffer.from('original-webgl-zip')]);
		});
		const outDir = await fsp.mkdtemp(join(tmpdir(), 'pcu-webgl-export-'));
		tempDirs.push(outDir);

		const first = await exportService.exportAssets({ outDir });
		const exportedPath = join(
			outDir,
			'ExportedAssets',
			'2026_전시',
			'실제내보내기',
			'webgl',
			'webgl.zip',
		);
		expect(first).toMatchObject({ downloaded: 1, skipped: 0, failed: 0 });
		expect(await fsp.readFile(exportedPath, 'utf8')).toBe('original-webgl-zip');
		expect(captured.progress?.currentProjectFiles[0]).toMatchObject({
			assetId: -19,
			kind: 'WEBGL',
		});
		expect(ExportStatusResponseSchema.safeParse({
			running: true,
			progress: captured.progress,
		}).success).toBe(true);
		expect(mocks.getObject).toHaveBeenCalledWith('pcu-protected', sourceKey, expect.any(AbortSignal));

		const second = await exportService.exportAssets({ outDir });
		expect(second).toMatchObject({ downloaded: 0, skipped: 1, failed: 0 });
		expect(mocks.getObject).toHaveBeenCalledTimes(1);
	});
});
