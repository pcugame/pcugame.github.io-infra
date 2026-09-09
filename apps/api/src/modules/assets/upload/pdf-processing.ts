/**
 * PDF image processing — rasterize page one once, then branch the raster into
 * the canonical WebP and responsive derivatives.
 */

import { pdf } from 'pdf-to-img';
import sharp from 'sharp';
import type { FileSystem } from '../../../application/ports.js';
import { badRequest } from '../../../shared/errors.js';
import {
	encodeImageBundle,
	ImageOutputCleanupError,
	type ImageProcessingResult,
} from './image-processing.js';

export interface PdfProcessingInput {
	tmpPath: string;
	/** IMAGE/POSTER create renditions; THUMBNAIL deliberately remains canonical-only. */
	createRenditions?: boolean;
}

export interface PdfProcessingLogger {
	warn(value: unknown, message?: string): void;
	error(value: unknown, message?: string): void;
}

/** Scale factor passed to pdfjs (roughly doubles resolution). */
const PDF_SCALE = 2;
/** Canonical PDF raster is bounded to 2,000px on either axis. */
const MAX_DIMENSION = 2000;

function boundedDimensions(width: number, height: number): {
	width: number;
	height: number;
} {
	const scale = Math.min(1, MAX_DIMENSION / width, MAX_DIMENSION / height);
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

export async function processPdf(
	input: PdfProcessingInput,
	logger: PdfProcessingLogger,
	fileSystem: Pick<FileSystem, 'remove'>,
): Promise<ImageProcessingResult> {
	let pngBuffer: Buffer;
	let document: Awaited<ReturnType<typeof pdf>> | undefined;
	try {
		document = await pdf(input.tmpPath, { scale: PDF_SCALE });
		if (document.length < 1) throw new Error('PDF has no pages');
		pngBuffer = await document.getPage(1);
	} catch (error) {
		throw translatePdfError(error, logger);
	} finally {
		const destroy = (document as { destroy?: () => Promise<void> } | undefined)?.destroy;
		if (destroy) {
			await destroy.call(document).catch((cleanupError: unknown) => {
				logger.warn(
					{ err: cleanupError, tmpPath: input.tmpPath },
					'Failed to destroy PDF document',
				);
			});
		}
	}

	try {
		const source = sharp(pngBuffer, { failOn: 'error' }).resize({
			width: MAX_DIMENSION,
			height: MAX_DIMENSION,
			fit: 'inside',
			withoutEnlargement: true,
		});
		const metadata = await source.metadata();
		if (!metadata.width || !metadata.height) {
			throw new Error('PDF page raster has no dimensions');
		}
		const dimensions = boundedDimensions(metadata.width, metadata.height);
		return await encodeImageBundle({
			source,
			outputBasePath: input.tmpPath,
			sourceWidth: dimensions.width,
			sourceHeight: dimensions.height,
			createRenditions: input.createRenditions ?? true,
		}, fileSystem);
	} catch (error) {
		if (error instanceof ImageOutputCleanupError) throw error;
		throw translatePdfError(error, logger);
	}
}

function translatePdfError(error: unknown, logger?: PdfProcessingLogger): Error {
	const message = error instanceof Error ? error.message : String(error);
	logger?.error({ err: error }, 'PDF rasterization failed');

	const lower = message.toLowerCase();
	if (lower.includes('password') || lower.includes('encrypted')) {
		return badRequest('Password-protected PDFs are not supported');
	}
	return badRequest('Invalid or unsupported PDF');
}
