import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { ImageRejectedError } from './errors.js';
import { assertPdfPagePolicy, assertRasterPolicy, type ImageWorkerLimits } from './policy.js';
import type { BoundedImageCommandRunner, ImageOperations, LocalImageOutput, RasterInfo } from './ports.js';

async function assertRegular(path: string): Promise<void> {
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new ImageRejectedError('Worker input/output must be a regular file', 'RESOURCE_LIMIT');
	}
}

async function sha256(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}

function orientedDimensions(metadata: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>) {
	if (!metadata.width || !metadata.height) throw new ImageRejectedError('Decoded raster has no dimensions', 'RASTER_INVALID');
	const swap = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
	return swap ? { width: metadata.height, height: metadata.width } : { width: metadata.width, height: metadata.height };
}

async function outputRecord(input: Omit<LocalImageOutput, 'sizeBytes' | 'checksumSha256'>, maxBytes: number): Promise<LocalImageOutput> {
	await assertRegular(input.path);
	const metadata = await stat(input.path);
	if (metadata.size < 1 || metadata.size > maxBytes) {
		throw new ImageRejectedError('Generated image output exceeds policy', 'RESOURCE_LIMIT');
	}
	return { ...input, sizeBytes: metadata.size, checksumSha256: await sha256(input.path) };
}

function parsePdfPages(stdout: string): number {
	const match = /^Pages:\s+(\d+)\s*$/im.exec(stdout);
	if (!match?.[1]) throw new ImageRejectedError('PDF parser did not return a page count', 'PDF_INVALID');
	return Number(match[1]);
}

export function createImageOperations(
	runner: BoundedImageCommandRunner,
	limits: ImageWorkerLimits,
): ImageOperations {
	return {
		async inspectRaster(path, signal): Promise<RasterInfo> {
			if (signal?.aborted) throw signal.reason;
			await assertRegular(path);
			try {
				const source = sharp(path, { failOn: 'error', limitInputPixels: limits.maxPixels, animated: true }).rotate();
				const metadata = await source.metadata();
				const dimensions = orientedDimensions(metadata);
				const info = {
					...dimensions,
					pages: metadata.pages ?? 1,
					channels: metadata.channels ?? 4,
				};
				assertRasterPolicy(info, limits);
				const decoded = await source.clone().ensureAlpha().raw().toBuffer();
				if (decoded.byteLength > limits.maxDecodedBytes) {
					throw new ImageRejectedError('Decoded raster memory exceeds policy', 'RESOURCE_LIMIT');
				}
				return info;
			} catch (error) {
				if (error instanceof ImageRejectedError) throw error;
				throw new ImageRejectedError('Raster decoder rejected corrupt or unsupported input', 'RASTER_INVALID', { cause: error });
			}
		},

		async renderPdfFirstPage(inputPath, outputPath, signal) {
			await assertRegular(inputPath);
			const root = resolve(dirname(inputPath));
			const output = resolve(outputPath);
			if (dirname(output) !== root || basename(output).includes('/') || extname(output) !== '.png') {
				throw new ImageRejectedError('PDF output path escaped its private workspace', 'RESOURCE_LIMIT');
			}
			const info = await runner.run({
				file: 'pdfinfo', args: [inputPath], timeoutMs: limits.pdfTimeoutMs,
				maxOutputBytes: limits.commandOutputBytes, signal,
			});
			const pages = parsePdfPages(info.stdout);
			assertPdfPagePolicy(pages, limits);
			await runner.run({
				file: 'pdftoppm',
				args: ['-f', '1', '-l', '1', '-singlefile', '-png', '-r', '144', inputPath, output.slice(0, -4)],
				timeoutMs: limits.pdfTimeoutMs, maxOutputBytes: limits.commandOutputBytes, signal,
			});
			await assertRegular(outputPath);
			return { pages };
		},

		async createOutputs(input) {
			if (input.signal?.aborted) throw input.signal.reason;
			const rasterPath = input.sourceMimeType === 'application/pdf' ? input.pdfRasterPath : input.sourcePath;
			if (!rasterPath) throw new ImageRejectedError('PDF raster output is missing', 'PDF_INVALID');
			await assertRegular(rasterPath);
			const source = sharp(rasterPath, { failOn: 'error', limitInputPixels: limits.maxPixels }).rotate();
			const metadata = await source.metadata();
			const dimensions = orientedDimensions(metadata);
			const originalExtension = input.sourceMimeType === 'application/pdf' ? 'webp'
				: input.sourceMimeType === 'image/jpeg' ? 'jpg'
					: input.sourceMimeType === 'image/png' ? 'png' : 'webp';
			const originalMime = input.sourceMimeType === 'application/pdf' ? 'image/webp' : input.sourceMimeType;
			const originalPath = join(input.outputDirectory, `original.${originalExtension}`);
			if (input.sourceMimeType === 'application/pdf') {
				await source.clone().webp({ quality: 88 }).toFile(originalPath);
			} else {
				await copyFile(input.sourcePath, originalPath);
			}
			const renditionSpecs = [
				{ role: 'CARD_480' as const, width: 480, path: join(input.outputDirectory, 'card-480.webp') },
				{ role: 'DISPLAY_960' as const, width: 960, path: join(input.outputDirectory, 'display-960.webp') },
			];
			// Encode sequentially: libvips may otherwise hold multiple decoded pixel
			// graphs at once and defeat the worker's decoded-memory budget.
			for (const rendition of renditionSpecs) {
				await source.clone().resize({ width: rendition.width, withoutEnlargement: true })
					.webp({ quality: 82 }).toFile(rendition.path);
			}
			const outputs = [await outputRecord({
				role: 'ORIGINAL', path: originalPath, mimeType: originalMime,
				extension: originalExtension, ...dimensions,
			}, limits.maxOutputBytes)];
			for (const rendition of renditionSpecs) {
				const outputMetadata = await sharp(rendition.path).metadata();
				if (!outputMetadata.width || !outputMetadata.height) throw new ImageRejectedError('Rendition dimensions missing', 'RASTER_INVALID');
				outputs.push(await outputRecord({
					role: rendition.role, path: rendition.path, mimeType: 'image/webp', extension: 'webp',
					width: outputMetadata.width, height: outputMetadata.height,
				}, limits.maxOutputBytes));
			}
			return outputs;
		},
	};
}

export const imageOperationInternals = { parsePdfPages };
