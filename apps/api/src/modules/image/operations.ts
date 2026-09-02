import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { ImageRejectedError } from './errors.js';
import { AggregateOutputBudget, writeBoundedOutput } from './output-budget.js';
import { assertPdfPagePolicy, assertRasterPolicy, type ImageWorkerLimits } from './policy.js';
import type { BoundedImageCommandRunner, ImageOperations, LocalImageOutput, RasterInfo } from './ports.js';

async function assertRegular(path: string): Promise<void> {
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new ImageRejectedError('Worker input/output must be a regular file', 'RESOURCE_LIMIT');
	}
}

async function privateWorkspaceUsage(path: string): Promise<number> {
	const root = resolve(path);
	const metadata = await lstat(root);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(root) !== root) {
		throw new ImageRejectedError('Image output workspace must be a real private directory', 'RESOURCE_LIMIT');
	}
	let bytes = 0;
	for (const entry of await readdir(root)) {
		const child = join(root, entry);
		const childMetadata = await lstat(child);
		if (!childMetadata.isFile() || childMetadata.isSymbolicLink()) {
			throw new ImageRejectedError('Image workspace contains an unsupported filesystem entry', 'RESOURCE_LIMIT');
		}
		if (!Number.isSafeInteger(childMetadata.size) || childMetadata.size > Number.MAX_SAFE_INTEGER - bytes) {
			throw new ImageRejectedError('Image workspace size is not safely representable', 'RESOURCE_LIMIT');
		}
		bytes += childMetadata.size;
	}
	return bytes;
}

function assertWorkspaceFile(rootPath: string, filePath: string, extension?: string): string {
	const root = resolve(rootPath);
	const file = resolve(filePath);
	if (dirname(file) !== root || basename(file) !== basename(filePath)
		|| (extension !== undefined && extname(file) !== extension)) {
		throw new ImageRejectedError('Image output path escaped its private workspace', 'RESOURCE_LIMIT');
	}
	return file;
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
			const output = assertWorkspaceFile(root, outputPath, '.png');
			const info = await runner.run({
				file: 'pdfinfo', args: [inputPath], timeoutMs: limits.pdfTimeoutMs,
				maxOutputBytes: limits.commandOutputBytes, signal,
			});
			const pages = parsePdfPages(info.stdout);
			assertPdfPagePolicy(pages, limits);
			const remainingBytes = limits.maxTempBytes - await privateWorkspaceUsage(root);
			const outputBudget = Math.min(limits.maxOutputBytes, remainingBytes);
			if (!Number.isSafeInteger(outputBudget) || outputBudget < 1) {
				throw new ImageRejectedError('PDF raster has no remaining temp-disk budget', 'RESOURCE_LIMIT');
			}
			try {
				await runner.run({
					file: 'pdftoppm',
					// With one selected page and no output prefix, Poppler writes PNG bytes to stdout.
					args: ['-f', '1', '-l', '1', '-singlefile', '-png', '-r', '144', inputPath],
					timeoutMs: limits.pdfTimeoutMs, maxOutputBytes: limits.commandOutputBytes,
					stdoutFile: { path: output, maxBytes: outputBudget }, signal,
				});
			} catch (error) {
				await rm(output, { force: true }).catch(() => undefined);
				throw error;
			}
			await assertRegular(outputPath);
			const outputMetadata = await stat(outputPath);
			if (outputMetadata.size < 1 || outputMetadata.size > outputBudget) {
				await rm(output, { force: true }).catch(() => undefined);
				throw new ImageRejectedError('PDF raster exceeded its write-time budget', 'RESOURCE_LIMIT');
			}
			return { pages };
		},

		async createOutputs(input) {
			if (input.signal?.aborted) throw input.signal.reason;
			const root = resolve(input.outputDirectory);
			const rasterPath = input.sourceMimeType === 'application/pdf' ? input.pdfRasterPath : input.sourcePath;
			if (!rasterPath) throw new ImageRejectedError('PDF raster output is missing', 'PDF_INVALID');
			assertWorkspaceFile(root, input.sourcePath);
			assertWorkspaceFile(root, rasterPath);
			await assertRegular(rasterPath);
			const source = sharp(rasterPath, { failOn: 'error', limitInputPixels: limits.maxPixels }).rotate();
			const metadata = await source.metadata();
			const dimensions = orientedDimensions(metadata);
			const originalExtension = input.sourceMimeType === 'application/pdf' ? 'webp'
				: input.sourceMimeType === 'image/jpeg' ? 'jpg'
					: input.sourceMimeType === 'image/png' ? 'png' : 'webp';
			const originalMime = input.sourceMimeType === 'application/pdf' ? 'image/webp' : input.sourceMimeType;
			const originalPath = assertWorkspaceFile(root, join(root, `original.${originalExtension}`));
			const renditionSpecs = [
				{ role: 'CARD_480' as const, width: 480, path: assertWorkspaceFile(root, join(root, 'card-480.webp')) },
				{ role: 'DISPLAY_960' as const, width: 960, path: assertWorkspaceFile(root, join(root, 'display-960.webp')) },
			];
			const initialBytes = await privateWorkspaceUsage(root);
			const aggregateBytes = limits.maxTempBytes - initialBytes;
			if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes < 1) {
				throw new ImageRejectedError('Image outputs have no remaining temp-disk budget', 'RESOURCE_LIMIT');
			}
			const aggregateBudget = new AggregateOutputBudget(aggregateBytes);
			const createdPaths = new Set<string>();
			try {
				await writeBoundedOutput({
					source: input.sourceMimeType === 'application/pdf'
						? source.clone().webp({ quality: 88 })
						: createReadStream(input.sourcePath),
					destination: originalPath,
					fileLimitBytes: limits.maxOutputBytes,
					aggregateBudget,
					onCreate: () => createdPaths.add(originalPath),
					...(input.signal ? { signal: input.signal } : {}),
				});
				// Encode sequentially: libvips may otherwise hold multiple decoded pixel
				// graphs at once and defeat the worker's decoded-memory budget.
				for (const rendition of renditionSpecs) {
					await writeBoundedOutput({
						source: source.clone().resize({ width: rendition.width, withoutEnlargement: true })
							.webp({ quality: 82 }),
						destination: rendition.path,
						fileLimitBytes: limits.maxOutputBytes,
						aggregateBudget,
						onCreate: () => createdPaths.add(rendition.path),
						...(input.signal ? { signal: input.signal } : {}),
					});
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
			} catch (error) {
				await Promise.all([...createdPaths].map((path) => rm(path, { force: true }).catch(() => undefined)));
				throw error;
			}
		},
	};
}

export const imageOperationInternals = { parsePdfPages };
