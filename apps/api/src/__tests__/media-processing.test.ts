import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processImage } from '../modules/assets/upload/image-processing.js';
import { processPdf } from '../modules/assets/upload/pdf-processing.js';

const directories: string[] = [];

async function createTemporaryFile(name: string, contents: Buffer): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), 'pcu-media-processing-'));
	directories.push(directory);
	const filePath = join(directory, name);
	await fs.writeFile(filePath, contents);
	return filePath;
}

function createPdf(options: { javaScript?: string } = {}): Buffer {
	const content = 'q\n0 0 1 rg\n0 0 32 32 re f\nQ\n';
	const javaScriptObject = options.javaScript
		? `5 0 obj\n<< /S /JavaScript /JS (${escapePdfString(options.javaScript)}) >>\nendobj\n`
		: undefined;
	const openAction = javaScriptObject ? ' /OpenAction 5 0 R' : '';
	const objects = [
		`1 0 obj\n<< /Type /Catalog /Pages 2 0 R${openAction} >>\nendobj\n`,
		'2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
		'3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 32 32] /Resources << >> /Contents 4 0 R >>\nendobj\n',
		`4 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream\nendobj\n`,
		...(javaScriptObject ? [javaScriptObject] : []),
	];

	let document = '%PDF-1.7\n';
	const offsets = objects.map((object) => {
		const offset = Buffer.byteLength(document);
		document += object;
		return offset;
	});
	const xrefOffset = Buffer.byteLength(document);
	document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	document += offsets
		.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
		.join('');
	document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(document);
}

function escapePdfString(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

describe('isolated media processors', () => {
	afterEach(async () => {
		delete (globalThis as { __pdfProcessorProbe?: unknown }).__pdfProcessorProbe;
		await Promise.all(directories.splice(0).map((directory) => (
			fs.rm(directory, { recursive: true, force: true })
		)));
	});

	it('rasterizes a normal PDF first page to a bounded WebP', async () => {
		const inputPath = await createTemporaryFile('poster.pdf', createPdf());
		const logger = { warn: vi.fn(), error: vi.fn() };

		const result = await processPdf({ tmpPath: inputPath }, logger, {
			remove: fs.unlink,
			stat: fs.stat,
		});

		expect(result).toMatchObject({
			tmpPath: `${inputPath}.webp`,
			mimeType: 'image/webp',
			ext: 'webp',
			converted: true,
		});
		expect(result.sizeBytes).toBeGreaterThan(0);
		await expect(sharp(result.tmpPath).metadata()).resolves.toMatchObject({
			format: 'webp',
			width: 64,
			height: 64,
		});
		expect(logger.error).not.toHaveBeenCalled();
	});

	it('does not execute an embedded PDF JavaScript action while rasterizing', async () => {
		const probe = 'globalThis.__pdfProcessorProbe = "executed"';
		const inputPath = await createTemporaryFile(
			'action.pdf',
			createPdf({ javaScript: probe }),
		);

		const result = await processPdf(
			{ tmpPath: inputPath },
			{ warn: vi.fn(), error: vi.fn() },
			{
			remove: fs.unlink,
			stat: fs.stat,
			},
		);

		expect(result.converted).toBe(true);
		expect((globalThis as { __pdfProcessorProbe?: unknown }).__pdfProcessorProbe)
			.toBeUndefined();
	});

	it('rejects a corrupt PDF without publishing a raster', async () => {
		const inputPath = await createTemporaryFile(
			'corrupt.pdf',
			Buffer.from('%PDF-1.7\n/JavaScript (malformed and truncated)'),
		);
		const logger = { warn: vi.fn(), error: vi.fn() };

		await expect(processPdf({ tmpPath: inputPath }, logger, {
			remove: fs.unlink,
			stat: fs.stat,
		})).rejects.toMatchObject({ statusCode: 400 });
		await expect(fs.access(`${inputPath}.webp`)).rejects.toThrow();
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.anything() }),
			'PDF rasterization failed',
		);
	});

	it('re-encodes a normal image and rejects malformed image bytes', async () => {
		const validPath = await createTemporaryFile(
			'valid.png',
			await sharp({
				create: {
					width: 2,
					height: 2,
					channels: 4,
					background: { r: 20, g: 40, b: 60, alpha: 1 },
				},
			}).png().toBuffer(),
		);
		const validResult = await processImage({
			tmpPath: validPath,
			mimeType: 'image/png',
			ext: 'png',
			sizeBytes: (await fs.stat(validPath)).size,
		}, { stat: fs.stat });

		expect(validResult).toMatchObject({
			tmpPath: `${validPath}.webp`,
			mimeType: 'image/webp',
			ext: 'webp',
			converted: true,
		});
		await expect(sharp(validResult.tmpPath).metadata()).resolves.toMatchObject({
			format: 'webp',
			width: 2,
			height: 2,
		});

		const corruptPath = await createTemporaryFile(
			'corrupt.png',
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
		);
		await expect(processImage({
			tmpPath: corruptPath,
			mimeType: 'image/png',
			ext: 'png',
			sizeBytes: 9,
		}, { stat: fs.stat })).rejects.toThrow();
		await expect(fs.access(`${corruptPath}.webp`)).rejects.toThrow();
	});
});
