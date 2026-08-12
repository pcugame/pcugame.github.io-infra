/**
 * Shared responsive-image processing pipeline.
 *
 * Every output is branched from the same oriented Sharp source. In particular,
 * renditions are never decoded from the canonical WebP, which avoids a second
 * lossy encode generation.
 */

import sharp, { type Sharp } from 'sharp';
import type { FileSystem } from '../../../application/ports.js';
import {
	IMAGE_RENDITION_PROFILES,
	type ImageRenditionProfile,
} from '../../../shared/responsive-image.js';

export interface ImageProcessingInput {
	/** Path to the source temp file on disk. */
	tmpPath: string;
	/** Detected MIME type (for example, image/jpeg). */
	mimeType: string;
	/** Detected file extension (for example, jpg). */
	ext: string;
	/** Source file size in bytes. */
	sizeBytes: number;
	/** IMAGE/POSTER create renditions; THUMBNAIL deliberately remains canonical-only. */
	createRenditions?: boolean;
}

export interface ProcessedImageOutput {
	tmpPath: string;
	mimeType: 'image/webp';
	ext: 'webp';
	sizeBytes: number;
	width: number;
	height: number;
	converted: true;
}

export interface ProcessedImageRendition
	extends Omit<ProcessedImageOutput, 'converted'> {
	profile: ImageRenditionProfile;
}

export interface ImageProcessingResult {
	original: ProcessedImageOutput;
	renditions: ProcessedImageRendition[];
}

export interface ImageRenditionProcessingInput {
	tmpPath: string;
	profiles: readonly ImageRenditionProfile[];
}

export interface ImageRenditionProcessingResult {
	width: number;
	height: number;
	renditions: ProcessedImageRendition[];
}

/** Shared encode policy for production uploads and legacy backfill. */
export const IMAGE_WEBP_QUALITY = {
	original: 85,
	rendition: 82,
} as const;

const CONVERTIBLE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface SharpBundleInput {
	source: Sharp;
	outputBasePath: string;
	sourceWidth: number;
	sourceHeight: number;
	createRenditions: boolean;
}

interface SharpOutputInput {
	source: Sharp;
	outputBasePath: string;
	sourceWidth: number;
	profiles: readonly ImageRenditionProfile[];
	includeOriginal: boolean;
}

interface PendingSharpOutput {
	kind: 'original' | 'rendition';
	profile?: ImageRenditionProfile;
	path: string;
	pipeline: Sharp;
}

export class ImageOutputCleanupError extends AggregateError {
	readonly residuePaths: readonly string[];

	constructor(errors: unknown[], residuePaths: readonly string[]) {
		super(errors, 'Responsive image encoding or partial-output cleanup failed');
		this.name = 'ImageOutputCleanupError';
		this.residuePaths = residuePaths;
	}
}

function outputPath(basePath: string, profile?: ImageRenditionProfile): string {
	return profile
		? `${basePath}.${profile.toLowerCase().replace('_', '-')}.webp`
		: `${basePath}.webp`;
}

function isMissingFile(error: unknown): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& error.code === 'ENOENT';
}

async function removePartialOutputs(
	paths: readonly string[],
	fileSystem: Pick<FileSystem, 'remove'>,
): Promise<{ errors: unknown[]; residuePaths: string[] }> {
	const results = await Promise.allSettled(paths.map((path) => fileSystem.remove(path)));
	const errors: unknown[] = [];
	const residuePaths: string[] = [];
	results.forEach((result, index) => {
		if (result.status !== 'rejected' || isMissingFile(result.reason)) return;
		errors.push(result.reason);
		const path = paths[index];
		if (path) residuePaths.push(path);
	});
	return { errors, residuePaths };
}

async function encodeSelectedOutputs(
	input: SharpOutputInput,
	fileSystem: Pick<FileSystem, 'remove'>,
): Promise<{
	original?: ProcessedImageOutput;
	renditions: ProcessedImageRendition[];
}> {
	const outputs: PendingSharpOutput[] = [];
	if (input.includeOriginal) {
		outputs.push({
			kind: 'original',
			path: outputPath(input.outputBasePath),
			pipeline: input.source.clone().webp({ quality: IMAGE_WEBP_QUALITY.original }),
		});
	}

	const selectedProfiles = new Set(input.profiles);
	for (const target of IMAGE_RENDITION_PROFILES) {
		if (!selectedProfiles.has(target.profile) || input.sourceWidth <= target.width) continue;
		outputs.push({
			kind: 'rendition',
			profile: target.profile,
			path: outputPath(input.outputBasePath, target.profile),
			pipeline: input.source.clone()
				.resize({ width: target.width, withoutEnlargement: true })
				.webp({ quality: IMAGE_WEBP_QUALITY.rendition }),
		});
	}

	const encoded = await Promise.allSettled(outputs.map(async (output) => ({
		output,
		info: await output.pipeline.toFile(output.path),
	})));
	const encodingErrors = encoded.flatMap((result) => (
		result.status === 'rejected' ? [result.reason] : []
	));
	if (encodingErrors.length > 0) {
		const cleanup = await removePartialOutputs(
			outputs.map((output) => output.path),
			fileSystem,
		);
		if (encodingErrors.length === 1 && cleanup.errors.length === 0) {
			throw encodingErrors[0];
		}
		if (cleanup.errors.length > 0) {
			throw new ImageOutputCleanupError(
				[...encodingErrors, ...cleanup.errors],
				cleanup.residuePaths,
			);
		}
		throw new AggregateError(encodingErrors, 'Responsive image encoding failed');
	}

	const completed = encoded.map((result) => {
		if (result.status !== 'fulfilled') throw new Error('Unreachable image encoding state');
		const { output, info } = result.value;
		return {
			output,
			value: {
				tmpPath: output.path,
				mimeType: 'image/webp' as const,
				ext: 'webp' as const,
				sizeBytes: info.size,
				width: info.width,
				height: info.height,
			},
		};
	});
	const original = completed.find(({ output }) => output.kind === 'original');
	return {
		...(original ? { original: { ...original.value, converted: true as const } } : {}),
		renditions: completed.flatMap(({ output, value }) => (
			output.kind === 'rendition' && output.profile
				? [{ ...value, profile: output.profile }]
				: []
		)),
	};
}

/**
 * Encode a canonical WebP and optional responsive derivatives from one Sharp
 * source graph. PDF rasterization uses this same branch point after rendering
 * page one, so neither raster nor canonical output is fed back into Sharp.
 */
export async function encodeImageBundle(
	input: SharpBundleInput,
	fileSystem: Pick<FileSystem, 'remove'>,
): Promise<ImageProcessingResult> {
	if (input.sourceWidth < 1 || input.sourceHeight < 1) {
		throw new Error('Decoded image has invalid dimensions');
	}
	const encoded = await encodeSelectedOutputs({
		source: input.source,
		outputBasePath: input.outputBasePath,
		sourceWidth: input.sourceWidth,
		profiles: input.createRenditions
			? IMAGE_RENDITION_PROFILES.map(({ profile }) => profile)
			: [],
		includeOriginal: true,
	}, fileSystem);
	if (!encoded.original) {
		throw new Error('Responsive image bundle is missing its canonical output');
	}
	return { original: encoded.original, renditions: encoded.renditions };
}

function orientedDimensions(metadata: Awaited<ReturnType<Sharp['metadata']>>): {
	width: number;
	height: number;
} {
	if (!metadata.width || !metadata.height) {
		throw new Error('Decoded image has no dimensions');
	}
	const swapsAxes = metadata.orientation !== undefined
		&& metadata.orientation >= 5
		&& metadata.orientation <= 8;
	return swapsAxes
		? { width: metadata.height, height: metadata.width }
		: { width: metadata.width, height: metadata.height };
}

/** Decode, auto-orient, strip metadata, and build a responsive WebP bundle. */
export async function processImage(
	input: ImageProcessingInput,
	fileSystem: Pick<FileSystem, 'remove'>,
): Promise<ImageProcessingResult> {
	if (!CONVERTIBLE_MIMES.has(input.mimeType)) {
		throw new Error(`Unsupported responsive image MIME type: ${input.mimeType}`);
	}

	// rotate() with no angle applies the EXIF orientation to pixels. Sharp strips
	// metadata by default on output, including the now-consumed orientation tag.
	const source = sharp(input.tmpPath, { failOn: 'error' }).rotate();
	const dimensions = orientedDimensions(await source.metadata());
	return encodeImageBundle({
		source,
		outputBasePath: input.tmpPath,
		sourceWidth: dimensions.width,
		sourceHeight: dimensions.height,
		createRenditions: input.createRenditions ?? true,
	}, fileSystem);
}

/**
 * Legacy/backfill entry point. It decodes the current canonical object once and
 * writes only the requested, size-appropriate derivatives; the canonical bytes
 * are never re-encoded or overwritten.
 */
export async function processImageRenditions(
	input: ImageRenditionProcessingInput,
	fileSystem: Pick<FileSystem, 'remove'>,
): Promise<ImageRenditionProcessingResult> {
	const source = sharp(input.tmpPath, { failOn: 'error' }).rotate();
	const dimensions = orientedDimensions(await source.metadata());
	const encoded = await encodeSelectedOutputs({
		source,
		outputBasePath: input.tmpPath,
		sourceWidth: dimensions.width,
		profiles: input.profiles,
		includeOriginal: false,
	}, fileSystem);
	return {
		width: dimensions.width,
		height: dimensions.height,
		renditions: encoded.renditions,
	};
}
