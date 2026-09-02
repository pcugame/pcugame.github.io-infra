import { access, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { createBoundedImageCommandRunner } from '../modules/image/command-runner.js';
import { ImageRejectedError } from '../modules/image/errors.js';
import { createImageOperations } from '../modules/image/operations.js';
import { AggregateOutputBudget, writeBoundedOutput } from '../modules/image/output-budget.js';
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

	it('stops real sharp/copy output at the aggregate temp boundary and removes generated files', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'image-ops-temp-bound-'));
		const source = path.join(root, 'source.png');
		await sharp({ create: { width: 32, height: 20, channels: 4, background: '#336699' } }).png().toFile(source);
		const sourceBytes = (await stat(source)).size;
		const operations = createImageOperations({ run: vi.fn() }, {
			...DEFAULT_IMAGE_WORKER_LIMITS,
			maxOutputBytes: sourceBytes,
			// The preserved ORIGINAL consumes the exact remainder; CARD_480's first
			// emitted byte must fail before another byte reaches disk.
			maxTempBytes: sourceBytes * 2,
		});
		try {
			await expect(operations.createOutputs({
				sourcePath: source, sourceMimeType: 'image/png', outputDirectory: root,
			})).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
			expect(await readFile(source)).toHaveLength(sourceBytes);
			await expect(readdir(root)).resolves.toEqual(['source.png']);
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
		const run = vi.fn(async (input: {
			file: string;
			args: readonly string[];
			stdoutFile?: { path: string; maxBytes: number };
		}) => {
			if (input.file === 'pdfinfo') return { stdout: 'Pages: 2\n', stderr: '' };
			await sharp({ create: { width: 10, height: 10, channels: 3, background: 'white' } }).png().toFile(output);
			return { stdout: '', stderr: '' };
		});
		const operations = createImageOperations({ run: run as never }, DEFAULT_IMAGE_WORKER_LIMITS);
		try {
			await expect(operations.renderPdfFirstPage(source, output)).resolves.toEqual({ pages: 2 });
			expect(run.mock.calls[1]![0]!.args.filter((value) => value === source)).toHaveLength(1);
			expect(run.mock.calls[1]![0]!.file).toBe('pdftoppm');
			expect(run.mock.calls[1]![0]!.args).not.toContain(output.slice(0, -4));
			expect(run.mock.calls[1]![0]!.stdoutFile).toEqual({
				path: output,
				maxBytes: DEFAULT_IMAGE_WORKER_LIMITS.maxOutputBytes,
			});
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it('admits exact output limits and rejects max+1 before it reaches disk', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'image-output-bound-'));
		try {
			const exactPath = path.join(root, 'exact.bin');
			const exactBudget = new AggregateOutputBudget(4);
			await expect(writeBoundedOutput({
				source: Readable.from([Buffer.from('1234')]), destination: exactPath,
				fileLimitBytes: 4, aggregateBudget: exactBudget,
			})).resolves.toBe(4);
			expect((await stat(exactPath)).size).toBe(4);

			const overflowPath = path.join(root, 'overflow.bin');
			await expect(writeBoundedOutput({
				source: Readable.from([Buffer.from('12345')]), destination: overflowPath,
				fileLimitBytes: 4, aggregateBudget: new AggregateOutputBudget(5),
			})).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
			await expect(access(overflowPath)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it('accounts aggregate bytes across files and removes only the overflowing partial file', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'image-output-aggregate-'));
		const budget = new AggregateOutputBudget(6);
		const first = path.join(root, 'first.bin');
		const second = path.join(root, 'second.bin');
		try {
			await writeBoundedOutput({
				source: Readable.from([Buffer.from('123')]), destination: first,
				fileLimitBytes: 5, aggregateBudget: budget,
			});
			await expect(writeBoundedOutput({
				source: Readable.from([Buffer.from('4567')]), destination: second,
				fileLimitBytes: 5, aggregateBudget: budget,
			})).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
			expect((await stat(first)).size).toBe(3);
			await expect(access(second)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it('kills a timed-out PDF process group', async () => {
		const runner = createBoundedImageCommandRunner();
		await expect(runner.run({
			file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 30, maxOutputBytes: 1024,
		})).rejects.toMatchObject({ code: 'PDF_TIMEOUT' });
	});

	it('streams command stdout with an exact disk ceiling and cleans overflow/timeout files', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'image-command-output-'));
		const runner = createBoundedImageCommandRunner();
		try {
			const exact = path.join(root, 'exact.bin');
			await expect(runner.run({
				file: process.execPath, args: ['-e', "process.stdout.write('1234')"],
				timeoutMs: 2_000, maxOutputBytes: 128, stdoutFile: { path: exact, maxBytes: 4 },
			})).resolves.toEqual({ stdout: '', stderr: '' });
			expect(await readFile(exact, 'utf8')).toBe('1234');

			const overflow = path.join(root, 'overflow.bin');
			await expect(runner.run({
				file: process.execPath, args: ['-e', "process.stdout.write('12345')"],
				timeoutMs: 2_000, maxOutputBytes: 128, stdoutFile: { path: overflow, maxBytes: 4 },
			})).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
			await expect(access(overflow)).rejects.toMatchObject({ code: 'ENOENT' });

			const timeout = path.join(root, 'timeout.bin');
			await expect(runner.run({
				file: process.execPath,
				args: ['-e', "process.stdout.write('x'); setInterval(() => process.stdout.write('x'), 1000)"],
				timeoutMs: 30, maxOutputBytes: 128, stdoutFile: { path: timeout, maxBytes: 128 },
			})).rejects.toMatchObject({ code: 'PDF_TIMEOUT' });
			await expect(access(timeout)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it('refuses symlink output destinations without changing their targets', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'image-output-symlink-'));
		const target = path.join(root, 'target.bin');
		const link = path.join(root, 'output.bin');
		await writeFile(target, 'safe');
		await symlink(target, link);
		try {
			await expect(createBoundedImageCommandRunner().run({
				file: process.execPath, args: ['-e', "process.stdout.write('owned')"],
				timeoutMs: 2_000, maxOutputBytes: 128, stdoutFile: { path: link, maxBytes: 128 },
			})).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
			expect(await readFile(target, 'utf8')).toBe('safe');
		} finally { await rm(root, { recursive: true, force: true }); }
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
