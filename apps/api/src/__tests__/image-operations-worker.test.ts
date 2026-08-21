import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createBoundedImageCommandRunner } from '../modules/image/command-runner.js';
import { ImageRejectedError } from '../modules/image/errors.js';
import { createImageOperations } from '../modules/image/operations.js';
import { assertRasterPolicy, DEFAULT_IMAGE_WORKER_LIMITS } from '../modules/image/policy.js';

describe('bounded image operations', () => {
	it('fully decodes a raster, preserves validated original bytes, and emits every responsive role', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'image-ops-'));
		const source = path.join(root, 'source.png');
		await sharp({ create: { width: 32, height: 20, channels: 4, background: '#336699' } }).png().toFile(source);
		const operations = createImageOperations({ run: vi.fn() }, DEFAULT_IMAGE_WORKER_LIMITS);
		try {
			await expect(operations.inspectRaster(source)).resolves.toMatchObject({ width: 32, height: 20, pages: 1 });
			const outputs = await operations.createOutputs({
				sourcePath: source, sourceMimeType: 'image/png', outputDirectory: root,
			});
			expect(outputs.map(({ role }) => role)).toEqual(['ORIGINAL', 'CARD_480', 'DISPLAY_960']);
			expect(await readFile(outputs[0]!.path)).toEqual(await readFile(source));
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it('rejects corrupt decoder input and pixel/memory bombs', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'image-corrupt-'));
		const source = path.join(root, 'corrupt.png');
		await writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		const operations = createImageOperations({ run: vi.fn() }, DEFAULT_IMAGE_WORKER_LIMITS);
		try {
			await expect(operations.inspectRaster(source)).rejects.toMatchObject({ code: 'RASTER_INVALID' });
			expect(() => assertRasterPolicy({ width: 100_000, height: 100_000, pages: 1, channels: 4 },
				DEFAULT_IMAGE_WORKER_LIMITS)).toThrowError(ImageRejectedError);
			expect(() => assertRasterPolicy({ width: 10, height: 10, pages: 2, channels: 4 },
				DEFAULT_IMAGE_WORKER_LIMITS)).toThrowError(expect.objectContaining({ code: 'ANIMATION_UNSUPPORTED' }));
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it('rejects symlinked worker input paths', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'image-symlink-'));
		const target = path.join(root, 'target.png');
		const link = path.join(root, 'source.png');
		await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toFile(target);
		await symlink(target, link);
		const operations = createImageOperations({ run: vi.fn() }, DEFAULT_IMAGE_WORKER_LIMITS);
		try {
			await expect(operations.inspectRaster(link)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it('bounds PDF parser/renderer execution and uses fixed argv paths', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'image-pdf-'));
		const source = path.join(root, 'source;touch injected.pdf');
		const output = path.join(root, 'page.png');
		await writeFile(source, '%PDF-1.4\n');
		const run = vi.fn(async (input: { file: string; args: readonly string[] }) => {
			if (input.file === 'pdfinfo') return { stdout: 'Pages: 2\n', stderr: '' };
			await sharp({ create: { width: 10, height: 10, channels: 3, background: 'white' } }).png().toFile(output);
			return { stdout: '', stderr: '' };
		});
		const operations = createImageOperations({ run: run as never }, DEFAULT_IMAGE_WORKER_LIMITS);
		try {
			await expect(operations.renderPdfFirstPage(source, output)).resolves.toEqual({ pages: 2 });
			expect(run.mock.calls[1]![0]!.args.filter((value) => value === source)).toHaveLength(1);
			expect(run.mock.calls[1]![0]!.file).toBe('pdftoppm');
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it('kills a timed-out PDF process group', async () => {
		const runner = createBoundedImageCommandRunner();
		await expect(runner.run({
			file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 30, maxOutputBytes: 1024,
		})).rejects.toMatchObject({ code: 'PDF_TIMEOUT' });
	});

	it('rejects PDF parser failures and command output bombs', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'image-pdf-invalid-'));
		const source = path.join(root, 'source.pdf');
		const output = path.join(root, 'page.png');
		await writeFile(source, '%PDF-1.4\n');
		const operations = createImageOperations({
			run: vi.fn(async () => ({ stdout: 'not pdfinfo output', stderr: '' })),
		}, DEFAULT_IMAGE_WORKER_LIMITS);
		try {
			await expect(operations.renderPdfFirstPage(source, output)).rejects.toMatchObject({ code: 'PDF_INVALID' });
		} finally { await rm(root, { recursive: true, force: true }); }

		const runner = createBoundedImageCommandRunner();
		await expect(runner.run({
			file: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(10000))"],
			timeoutMs: 2_000, maxOutputBytes: 128,
		})).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
	});
});
