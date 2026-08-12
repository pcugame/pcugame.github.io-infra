import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	IMAGE_WEBP_QUALITY,
	processImage,
	processImageRenditions,
} from '../modules/assets/upload/image-processing.js';
import { processPdf } from '../modules/assets/upload/pdf-processing.js';

const directories: string[] = [];
const outputFileSystem = { remove: fs.unlink };

async function createTemporaryFile(name: string, contents: Buffer): Promise<string> {
	const directory = await fs.mkdtemp(join(tmpdir(), 'pcu-media-processing-'));
	directories.push(directory);
	const filePath = join(directory, name);
	await fs.writeFile(filePath, contents);
	return filePath;
}

function createPdf(options: {
	javaScript?: string;
	passwordProtected?: boolean;
	width?: number;
	height?: number;
} = {}): Buffer {
	const width = options.width ?? 32;
	const height = options.height ?? 32;
	const content = `q\n0 0 1 rg\n0 0 ${width} ${height} re f\nQ\n`;
	const javaScriptObject = options.javaScript
		? `5 0 obj\n<< /S /JavaScript /JS (${escapePdfString(options.javaScript)}) >>\nendobj\n`
		: undefined;
	const encryptionObjectNumber = javaScriptObject ? 6 : 5;
	const encryptionObject = options.passwordProtected
		? `${encryptionObjectNumber} 0 obj\n<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${'00'.repeat(32)}> /U <${'11'.repeat(32)}> /P -4 >>\nendobj\n`
		: undefined;
	const openAction = javaScriptObject ? ' /OpenAction 5 0 R' : '';
	const objects = [
		`1 0 obj\n<< /Type /Catalog /Pages 2 0 R${openAction} >>\nendobj\n`,
		'2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
		`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << >> /Contents 4 0 R >>\nendobj\n`,
		`4 0 obj\n<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream\nendobj\n`,
		...(javaScriptObject ? [javaScriptObject] : []),
		...(encryptionObject ? [encryptionObject] : []),
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
	const encryptionTrailer = options.passwordProtected
		? ` /Encrypt ${encryptionObjectNumber} 0 R /ID [<${'22'.repeat(16)}><${'22'.repeat(16)}>]`
		: '';
	document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptionTrailer} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(document);
}

function escapePdfString(value: string): string {
	return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

describe('responsive media processors', () => {
	afterEach(async () => {
		delete (globalThis as { __pdfProcessorProbe?: unknown }).__pdfProcessorProbe;
		await Promise.all(directories.splice(0).map((directory) => (
			fs.rm(directory, { recursive: true, force: true })
		)));
	});

	it('keeps the canonical and rendition WebP quality policy explicit', () => {
		expect(IMAGE_WEBP_QUALITY).toEqual({ original: 85, rendition: 82 });
	});

	it('rasterizes only the first PDF page to a bounded canonical WebP', async () => {
		const inputPath = await createTemporaryFile('poster.pdf', createPdf());
		const logger = { warn: vi.fn(), error: vi.fn() };

		const result = await processPdf({ tmpPath: inputPath }, logger, outputFileSystem);

		expect(result.original).toMatchObject({
			tmpPath: `${inputPath}.webp`,
			mimeType: 'image/webp',
			ext: 'webp',
			converted: true,
			width: 64,
			height: 64,
		});
		expect(result.original.sizeBytes).toBeGreaterThan(0);
		expect(result.renditions).toEqual([]);
		await expect(sharp(result.original.tmpPath).metadata()).resolves.toMatchObject({
			format: 'webp',
			width: 64,
			height: 64,
		});
		expect(logger.error).not.toHaveBeenCalled();
	});

	it('caps a PDF raster at 2,000px and creates renditions from that raster', async () => {
		const inputPath = await createTemporaryFile(
			'wide.pdf',
			createPdf({ width: 1200, height: 120 }),
		);
		const result = await processPdf(
			{ tmpPath: inputPath },
			{ warn: vi.fn(), error: vi.fn() },
			outputFileSystem,
		);

		expect(result.original.width).toBe(2000);
		expect(result.original.height).toBe(200);
		expect(result.renditions.map(({ profile, width, height }) => ({
			profile,
			width,
			height,
		}))).toEqual([
			{ profile: 'CARD_480', width: 480, height: 48 },
			{ profile: 'DISPLAY_960', width: 960, height: 96 },
		]);
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
			outputFileSystem,
		);

		expect(result.original.converted).toBe(true);
		expect((globalThis as { __pdfProcessorProbe?: unknown }).__pdfProcessorProbe)
			.toBeUndefined();
	});

	it('rejects a corrupt PDF without publishing bundle outputs', async () => {
		const inputPath = await createTemporaryFile(
			'corrupt.pdf',
			Buffer.from('%PDF-1.7\n/JavaScript (malformed and truncated)'),
		);
		const logger = { warn: vi.fn(), error: vi.fn() };

		await expect(processPdf(
			{ tmpPath: inputPath },
			logger,
			outputFileSystem,
		)).rejects.toMatchObject({ statusCode: 400 });
		await expect(fs.access(`${inputPath}.webp`)).rejects.toThrow();
		await expect(fs.access(`${inputPath}.card-480.webp`)).rejects.toThrow();
		await expect(fs.access(`${inputPath}.display-960.webp`)).rejects.toThrow();
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.anything() }),
			'PDF rasterization failed',
		);
	});

	it('rejects a password-protected PDF without publishing bundle outputs', async () => {
		const inputPath = await createTemporaryFile(
			'password-protected.pdf',
			createPdf({ passwordProtected: true }),
		);
		const logger = { warn: vi.fn(), error: vi.fn() };

		await expect(processPdf(
			{ tmpPath: inputPath },
			logger,
			outputFileSystem,
		)).rejects.toMatchObject({
			statusCode: 400,
			message: 'Password-protected PDFs are not supported',
		});
		await expect(fs.access(`${inputPath}.webp`)).rejects.toThrow();
		await expect(fs.access(`${inputPath}.card-480.webp`)).rejects.toThrow();
		await expect(fs.access(`${inputPath}.display-960.webp`)).rejects.toThrow();
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({
				err: expect.objectContaining({ name: 'PasswordException' }),
			}),
			'PDF rasterization failed',
		);
	});

	it('normalizes JPEG orientation and strips source metadata', async () => {
		const inputPath = await createTemporaryFile(
			'oriented.jpg',
			await sharp({
				create: {
					width: 1200,
					height: 600,
					channels: 3,
					background: { r: 20, g: 40, b: 60 },
				},
			})
				.jpeg()
				.withMetadata({ orientation: 6 })
				.toBuffer(),
		);

		const result = await processImage({
			tmpPath: inputPath,
			mimeType: 'image/jpeg',
			ext: 'jpg',
			sizeBytes: (await fs.stat(inputPath)).size,
		}, outputFileSystem);
		const metadata = await sharp(result.original.tmpPath).metadata();

		expect(result.original).toMatchObject({ width: 600, height: 1200 });
		expect(result.renditions).toHaveLength(1);
		expect(result.renditions[0]).toMatchObject({
			profile: 'CARD_480',
			width: 480,
			height: 960,
		});
		expect(metadata.orientation).toBeUndefined();
		expect(metadata.exif).toBeUndefined();
		expect(metadata.xmp).toBeUndefined();
	});

	it('converts PNG to canonical WebP and exact aspect-preserving renditions', async () => {
		const inputPath = await createTemporaryFile(
			'large.png',
			await sharp({
				create: {
					width: 1200,
					height: 600,
					channels: 4,
					background: { r: 20, g: 40, b: 60, alpha: 1 },
				},
			}).png().toBuffer(),
		);
		const result = await processImage({
			tmpPath: inputPath,
			mimeType: 'image/png',
			ext: 'png',
			sizeBytes: (await fs.stat(inputPath)).size,
		}, outputFileSystem);

		expect(result.original).toMatchObject({
			tmpPath: `${inputPath}.webp`,
			mimeType: 'image/webp',
			ext: 'webp',
			converted: true,
			width: 1200,
			height: 600,
		});
		expect(result.renditions.map(({ profile, width, height }) => ({
			profile,
			width,
			height,
		}))).toEqual([
			{ profile: 'CARD_480', width: 480, height: 240 },
			{ profile: 'DISPLAY_960', width: 960, height: 480 },
		]);
	});

	it('freshly re-encodes WebP and omits targets that would enlarge the source', async () => {
		const inputPath = await createTemporaryFile(
			'small.webp',
			await sharp({
				create: {
					width: 480,
					height: 240,
					channels: 3,
					background: { r: 20, g: 40, b: 60 },
				},
			}).webp({ quality: 25 }).toBuffer(),
		);
		const result = await processImage({
			tmpPath: inputPath,
			mimeType: 'image/webp',
			ext: 'webp',
			sizeBytes: (await fs.stat(inputPath)).size,
		}, outputFileSystem);

		expect(result.original.tmpPath).not.toBe(inputPath);
		expect(result.original).toMatchObject({ width: 480, height: 240 });
		expect(result.renditions).toEqual([]);
	});

	it('can keep THUMBNAIL processing canonical-only even for a large source', async () => {
		const inputPath = await createTemporaryFile(
			'thumbnail.png',
			await sharp({
				create: {
					width: 1200,
					height: 600,
					channels: 3,
					background: { r: 20, g: 40, b: 60 },
				},
			}).png().toBuffer(),
		);
		const result = await processImage({
			tmpPath: inputPath,
			mimeType: 'image/png',
			ext: 'png',
			sizeBytes: (await fs.stat(inputPath)).size,
			createRenditions: false,
		}, outputFileSystem);

		expect(result.original).toMatchObject({ width: 1200, height: 600 });
		expect(result.renditions).toEqual([]);
	});

	it('creates only requested backfill renditions without replacing canonical bytes', async () => {
		const inputBytes = await sharp({
			create: {
				width: 1200,
				height: 600,
				channels: 3,
				background: { r: 20, g: 40, b: 60 },
			},
		}).webp({ quality: 85 }).toBuffer();
		const inputPath = await createTemporaryFile('legacy.webp', inputBytes);
		const result = await processImageRenditions({
			tmpPath: inputPath,
			profiles: ['DISPLAY_960', 'DISPLAY_960'],
		}, outputFileSystem);

		expect(result).toMatchObject({ width: 1200, height: 600 });
		expect(result.renditions).toHaveLength(1);
		expect(result.renditions[0]).toMatchObject({
			profile: 'DISPLAY_960',
			width: 960,
			height: 480,
		});
		expect(await fs.readFile(inputPath)).toEqual(inputBytes);
		await expect(fs.access(`${inputPath}.webp`)).rejects.toThrow();
	});

	it('rejects malformed image bytes without leaving bundle outputs', async () => {
		const inputPath = await createTemporaryFile(
			'corrupt.png',
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
		);
		await expect(processImage({
			tmpPath: inputPath,
			mimeType: 'image/png',
			ext: 'png',
			sizeBytes: 9,
		}, outputFileSystem)).rejects.toThrow();
		await expect(fs.access(`${inputPath}.webp`)).rejects.toThrow();
		await expect(fs.access(`${inputPath}.card-480.webp`)).rejects.toThrow();
		await expect(fs.access(`${inputPath}.display-960.webp`)).rejects.toThrow();
	});
});
