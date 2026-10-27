import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNasExportStaging } from '../modules/admin/export/nas-staging.adapter.js';

// The NAS adapter requires POSIX directory fsync, which Windows does not support.
describe.skipIf(process.platform === 'win32')('NAS export staging', () => {
	const roots: string[] = [];
	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	async function fixture() {
		const root = await mkdtemp(join(tmpdir(), 'nas-export-test-'));
		roots.push(root);
		const adapter = createNasExportStaging({ outDir: root, ids: { next: randomUUID }, logger: { warn: vi.fn() } });
		const stage = await adapter.prepare('job', 'hash');
		return { adapter, stage };
	}

	it('closes the file stream and publishes complete bytes without hanging', async () => {
		const { adapter, stage } = await fixture();
		await expect(adapter.writeObject({ stage, relativePath: 'project/video.mp4',
			body: Readable.from(['original video']), expectedBytes: 14, maxBytes: 20 })).resolves.toBe(14);
		const destination = await adapter.publish(stage, 'job', 'hash');
		expect(await readFile(join(destination, 'project/video.mp4'), 'utf8')).toBe('original video');
		expect(await adapter.prepare('job', 'hash')).toMatchObject({ state: 'READY' });
	}, 5_000);

	it.each([1, 20])('removes partial files when expected size %i mismatches the stream', async (expectedBytes) => {
		const { adapter, stage } = await fixture();
		await expect(adapter.writeObject({ stage, relativePath: 'video.mp4',
			body: Readable.from(['original video']), expectedBytes, maxBytes: 20 })).rejects.toThrow();
		expect(await readdir(stage.stagingPath)).toEqual([]);
	}, 5_000);

	it('persists the exact partial result in the report and recovery manifest', async () => {
		const { adapter, stage } = await fixture();
		const result = { projects: 1, totalFiles: 1, downloaded: 0, skipped: 1, failed: 0, aborted: false,
			paths: [], missingFiles: [{ projectId: 7, projectTitle: 'Game', assetId: 9, originalName: 'video.mp4',
				path: 'ExportedAssets/job/project/video.mp4', reason: 'SOURCE_MISSING' as const }] };
		const destination = await adapter.publish(stage, 'job', 'hash', result);
		expect(JSON.parse(await readFile(join(destination, 'export-report.json'), 'utf8'))).toEqual(result);
		expect((await adapter.prepare('job', 'hash')).result).toEqual(result);
	}, 5_000);

	it('closes and removes the partial file when a transfer is aborted', async () => {
		const { adapter, stage } = await fixture();
		const controller = new AbortController();
		const body = new Readable({ read() { this.push('x'); controller.abort(); } });
		await expect(adapter.writeObject({ stage, relativePath: 'video.mp4', body,
			expectedBytes: 20, maxBytes: 20, signal: controller.signal })).rejects.toThrow();
		expect(await readdir(stage.stagingPath)).toEqual([]);
	}, 5_000);
});
