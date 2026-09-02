import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { ExportSnapshot } from '../modules/admin/export/ports.js';
import { exportWorkerConfig } from '../export-worker.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import { createExportWorker, ExportSourceMissingError, planExport } from '../modules/admin/export/worker.js';

function snapshot(): ExportSnapshot {
	return {
		version: 1,
		jobId: 'job-1',
		year: 2026,
		createdAt: '2026-08-21T00:00:00.000Z',
		projects: [{
			id: 7,
			title: '../Game',
			exhibition: { year: 2026, title: 'Show/Final' },
			currentWebglDeploymentId: 'deployment-1',
			members: [{ name: 'Student', studentId: '20260001', sortOrder: 0 }],
			objects: [
				{ id: 'game', assetId: 1, kind: 'GAME', role: 'ORIGINAL', bucket: 'protected', objectKey: 'g', mimeType: 'application/zip', sizeBytes: 1, etag: 'g1', representationUpdatedAt: '2026-08-21T00:00:00.000Z', originalName: 'game.zip', source: 'canonical' },
				{ id: 'video', assetId: 2, kind: 'VIDEO', role: 'ORIGINAL', bucket: 'protected', objectKey: 'v', mimeType: 'video/mp4', sizeBytes: 1, etag: null, representationUpdatedAt: '2026-08-21T00:00:00.000Z', originalName: 'video.mp4', source: 'canonical' },
				{ id: 'poster', assetId: 3, kind: 'POSTER', role: 'ORIGINAL', bucket: 'public', objectKey: 'p', mimeType: 'image/png', sizeBytes: 1, etag: null, representationUpdatedAt: '2026-08-21T00:00:00.000Z', originalName: 'poster.png', source: 'canonical' },
				{ id: 'image', assetId: 4, kind: 'IMAGE', role: 'ORIGINAL', bucket: 'public', objectKey: 'i', mimeType: 'image/png', sizeBytes: 1, etag: null, representationUpdatedAt: '2026-08-21T00:00:00.000Z', originalName: 'image.png', source: 'canonical' },
				{ id: 'card', assetId: 4, kind: 'IMAGE', role: 'CARD_480', bucket: 'public', objectKey: 'c', mimeType: 'image/webp', sizeBytes: 1, etag: null, representationUpdatedAt: '2026-08-21T00:00:00.000Z', originalName: 'card.webp', source: 'canonical' },
				{ id: 'display', assetId: 4, kind: 'IMAGE', role: 'DISPLAY_960', bucket: 'public', objectKey: 'd', mimeType: 'image/webp', sizeBytes: 1, etag: null, representationUpdatedAt: '2026-08-21T00:00:00.000Z', originalName: 'display.webp', source: 'canonical' },
				{ id: 'webgl', assetId: 5, kind: 'WEBGL', role: 'WEBGL_SOURCE', bucket: 'protected', objectKey: 'w', mimeType: 'application/zip', sizeBytes: 1, etag: null, representationUpdatedAt: '2026-08-21T00:00:00.000Z', originalName: 'webgl.zip', source: 'canonical' },
			],
		}],
	};
}

function harness(overrides: { missingKey?: string; current?: boolean; complete?: boolean } = {}) {
	const value = snapshot();
	const written: string[] = [];
	const repository = {
		claimNext: vi.fn().mockResolvedValue({ id: 'job-1', year: 2026, dryRun: false,
			claimToken: 'claim', attemptCount: 1, maxAttempts: 3,
			createdAt: value.createdAt, snapshot: null, snapshotHash: null }),
		heartbeat: vi.fn().mockResolvedValue(true),
		loadOrCreateSnapshot: vi.fn().mockResolvedValue({ snapshot: value, hash: 'hash' }),
		snapshotStillCurrent: vi.fn().mockResolvedValue(overrides.current ?? true),
		complete: vi.fn().mockResolvedValue(overrides.complete ?? true),
		retryOrFail: vi.fn().mockResolvedValue('QUEUED'),
		failInvariant: vi.fn().mockResolvedValue(true),
	};
	const staging = {
		prepare: vi.fn().mockResolvedValue({ state: 'STAGING' as const, stagingPath: '/staging', finalPath: '/final' }),
		writeObject: vi.fn().mockImplementation(async ({ relativePath }: { relativePath: string }) => {
			written.push(relativePath);
			return 1;
		}),
		publish: vi.fn().mockResolvedValue('/final'),
		cleanup: vi.fn().mockResolvedValue(undefined),
	};
	const worker = createExportWorker({
		repository,
		staging,
		reader: { open: vi.fn().mockImplementation(async ({ objectKey }) => (
			objectKey === overrides.missingKey ? null : {
				body: Readable.from([Buffer.from('x')]), sizeBytes: 1,
				etag: objectKey === 'g' ? '"g1"' : null,
			}
		)) },
		ids: { next: () => 'claim' },
		options: { concurrency: 2, leaseMs: 10_000, maxObjectBytes: 10, maxJobBytes: 100, retryBaseMs: 1 },
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	});
	return { worker, repository, staging, written };
}

describe('canonical export worker', () => {
	it('requires a bounded private absolute NAS export root before opening worker resources', () => {
		const config = {
			...defaultTestEnv,
			NAS_EXPORT_ROOT: '/mnt/nas/private-exports',
	} as unknown as Parameters<typeof exportWorkerConfig>[0];
		expect(exportWorkerConfig(config).outDir).toBe('/mnt/nas/private-exports');
		expect(() => exportWorkerConfig({ ...config, NAS_EXPORT_ROOT: 'relative' }))
			.toThrow('absolute private path');
		expect(() => exportWorkerConfig({ ...config, NAS_EXPORT_ROOT: '/' }))
			.toThrow('must not be the legacy public storage path');
		expect(() => exportWorkerConfig({
			...config,
			NAS_EXPORT_ROOT: '/app/storage/public/exports',
			UPLOAD_ROOT_PUBLIC: '/app/storage/public',
		})).toThrow('must not be the legacy public storage path');
	});

	it('exports every master-visible original/rendition plus the canonical WebGL source before atomically completing', async () => {
		const { worker, repository, staging, written } = harness();
		await expect(worker.runPass()).resolves.toBe(1);
		expect(written).toHaveLength(7);
		expect(written.some((path) => path.endsWith('/game.zip'))).toBe(true);
		expect(written.some((path) => path.endsWith('/image_card_480.webp'))).toBe(true);
		expect(written.some((path) => path.endsWith('/image_display_960.webp'))).toBe(true);
		expect(written.some((path) => path.endsWith('/webgl/webgl.zip'))).toBe(true);
		expect(written.every((path) => !path.split('/').includes('..'))).toBe(true);
		expect(staging.publish).toHaveBeenCalledBefore(repository.complete);
		expect(repository.snapshotStillCurrent).toHaveBeenCalledOnce();
		expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({
			snapshotHash: 'hash', result: expect.objectContaining({ totalFiles: 7, downloaded: 7, failed: 0 }),
		}));
	});

	it('fails a missing Garage source as a terminal invariant and removes staging', async () => {
		const { worker, repository, staging } = harness({ missingKey: 'v' });
		await worker.runPass();
		expect(repository.failInvariant).toHaveBeenCalledWith(expect.objectContaining({
			error: new ExportSourceMissingError().message,
		}));
		expect(repository.retryOrFail).not.toHaveBeenCalled();
		expect(staging.cleanup).toHaveBeenCalledOnce();
		expect(staging.publish).not.toHaveBeenCalled();
	});

	it('does not publish when the immutable snapshot fence changes', async () => {
		const { worker, repository, staging } = harness({ current: false });
		await worker.runPass();
		expect(repository.failInvariant).toHaveBeenCalledOnce();
		expect(staging.publish).not.toHaveBeenCalled();
	});

	it('makes portable deterministic paths and disambiguates repeated asset kinds', () => {
		const value = snapshot();
		const paths = planExport(value).map((item) => item.relativePath);
		expect(paths.every((path) => !path.includes('Show/Final') && !path.includes('../'))).toBe(true);
		value.projects[0]!.objects.push({ ...value.projects[0]!.objects[0]!, id: 'game-duplicate' });
		expect(() => planExport(value)).not.toThrow();
	});

	it('keeps the Fastify control graph free of Garage reads, NAS writes, and worker imports', async () => {
		const [controller, service] = await Promise.all([
			readFile(new URL('../modules/admin/export/controller.ts', import.meta.url), 'utf8'),
			readFile(new URL('../modules/admin/export/service.ts', import.meta.url), 'utf8'),
		]);
		for (const source of [controller, service]) {
			expect(source).not.toMatch(/storage\.stream|createReadStream|createWriteStream|processing\.composition|worker\.js/);
		}
	});
});
