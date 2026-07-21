import { describe, expect, it, vi } from 'vitest';
import { createExportService, type ExportProject } from '../modules/admin/export/service.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function project(): ExportProject {
	return {
		id: 7,
		title: 'Game',
		webglEntryKey: '',
		exhibition: { year: 2026, title: 'Show' },
		members: [],
		assets: [
			{
				id: 1,
				kind: 'IMAGE',
				storageKey: 'one.png',
				originalName: 'one.png',
				mimeType: 'image/png',
				sizeBytes: 10n,
			},
			{
				id: 2,
				kind: 'GAME',
				storageKey: 'two.zip',
				originalName: 'two.zip',
				mimeType: 'application/zip',
				sizeBytes: 20n,
			},
		],
	};
}

function createDependencies(findProjects = vi.fn().mockResolvedValue([])) {
	return {
		findProjects,
		pathExists: vi.fn().mockResolvedValue(false),
		ensureDirectory: vi.fn().mockResolvedValue(undefined),
		saveObject: vi.fn().mockResolvedValue(undefined),
		bucketForKind: vi.fn().mockReturnValue('public'),
		protectedBucket: 'protected',
		now: () => 1_721_537_200_000,
		logWarn: vi.fn(),
		logError: vi.fn(),
	};
}

describe('export service execution and process-local lock', () => {
	it('rejects concurrent execution and releases the lock for a later retry', async () => {
		const gate = deferred<ExportProject[]>();
		const findProjects = vi.fn()
			.mockReturnValueOnce(gate.promise)
			.mockResolvedValue([]);
		const service = createExportService(createDependencies(findProjects));

		const first = service.exportAssets({ outDir: '/exports' });
		expect(service.getExportProgress()).toMatchObject({ phase: 'preparing' });
		await expect(service.exportAssets({ outDir: '/exports' })).rejects.toMatchObject({
			statusCode: 409,
			code: 'CONFLICT',
		});

		gate.resolve([]);
		await expect(first).resolves.toMatchObject({ projects: 0, failed: 0 });
		expect(service.getExportProgress()).toBeNull();
		await expect(service.exportAssets({ outDir: '/exports' })).resolves.toMatchObject({
			projects: 0,
		});
	});

	it('honors an abort signal before writing the first project', async () => {
		const deps = createDependencies(vi.fn().mockResolvedValue([project()]));
		const service = createExportService(deps);
		const abort = new AbortController();
		abort.abort();

		await expect(service.exportAssets({ outDir: '/exports', signal: abort.signal }))
			.resolves.toMatchObject({ aborted: true, downloaded: 0, failed: 0 });
		expect(deps.saveObject).not.toHaveBeenCalled();
		expect(service.getExportProgress()).toBeNull();
	});

	it('records a failed object and continues with remaining files', async () => {
		const deps = createDependencies(vi.fn().mockResolvedValue([project()]));
		deps.saveObject.mockImplementation(async (_bucket, key) => {
			if (key === 'one.png') throw new Error('storage unavailable');
		});
		const service = createExportService(deps);

		await expect(service.exportAssets({ outDir: '/exports' })).resolves.toMatchObject({
			totalFiles: 2,
			downloaded: 1,
			failed: 1,
			aborted: false,
		});
		expect(deps.saveObject).toHaveBeenCalledTimes(2);
		expect(deps.logError).toHaveBeenCalledOnce();
	});

	it('releases progress state when project loading throws', async () => {
		const deps = createDependencies(vi.fn().mockRejectedValue(new Error('database unavailable')));
		const service = createExportService(deps);

		await expect(service.exportAssets({ outDir: '/exports' }))
			.rejects.toThrow('database unavailable');
		expect(service.getExportProgress()).toBeNull();
	});
});
