import { Readable } from 'node:stream';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTestEnv } from './helpers/app-mocks.js';

const mocks = vi.hoisted(() => ({
	findProjectsWithAssets: vi.fn(),
	s3Send: vi.fn(),
}));

vi.mock('../config/env.js', () => ({
	env: () => ({ ...defaultTestEnv }),
	loadEnv: () => ({ ...defaultTestEnv }),
}));
vi.mock('../modules/admin/export/repository.js', () => ({
	findProjectsWithAssets: mocks.findProjectsWithAssets,
}));
vi.mock('../lib/s3.js', () => ({
	s3: () => ({ send: mocks.s3Send }),
	bucketForKind: vi.fn(() => 'bucket'),
}));

import { exportAssets, getExportProgress } from '../modules/admin/export/service.js';

const tempDirs: string[] = [];

describe('NAS WebGL export', () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
	});

	it('counts and dry-runs only the original ZIP at webgl/webgl.zip', async () => {
		mocks.findProjectsWithAssets.mockResolvedValueOnce([{
			id: 17,
			title: '작품',
			webglEntryKey: 'webgl/17/123e4567-e89b-42d3-a456-426614174000/site/index.html',
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

		const result = await exportAssets({ outDir: '/mnt/nas', dryRun: true });
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
			exhibition: { year: 2026, title: '' },
			members: [],
			assets: [],
		}]);
		const result = await exportAssets({ outDir: '/mnt/nas', dryRun: true });
		expect(result).toMatchObject({ projects: 1, totalFiles: 1, failed: 0 });
		expect(result.paths[0]).toBe('/mnt/nas/ExportedAssets/2026/웹게임/webgl/webgl.zip');
	});

	it('writes the original ZIP, reports WebGL progress, and skips an existing export', async () => {
		const sourceKey = 'webgl/19/123e4567-e89b-42d3-a456-426614174000/source.zip';
		mocks.findProjectsWithAssets.mockResolvedValue([{
			id: 19,
			title: '실제내보내기',
			webglEntryKey: 'webgl/19/123e4567-e89b-42d3-a456-426614174000/site/index.html',
			exhibition: { year: 2026, title: '전시' },
			members: [],
			assets: [],
		}]);
		let progressKind: string | undefined;
		mocks.s3Send.mockImplementation(async () => {
			progressKind = getExportProgress()?.currentProjectFiles[0]?.kind;
			return { Body: Readable.from([Buffer.from('original-webgl-zip')]) };
		});
		const outDir = await fsp.mkdtemp(join(tmpdir(), 'pcu-webgl-export-'));
		tempDirs.push(outDir);

		const first = await exportAssets({ outDir });
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
		expect(progressKind).toBe('WEBGL');
		expect(mocks.s3Send.mock.calls[0]?.[0]?.input).toEqual({
			Bucket: 'pcu-protected',
			Key: sourceKey,
		});

		const second = await exportAssets({ outDir });
		expect(second).toMatchObject({ downloaded: 0, skipped: 1, failed: 0 });
		expect(mocks.s3Send).toHaveBeenCalledTimes(1);
	});
});
