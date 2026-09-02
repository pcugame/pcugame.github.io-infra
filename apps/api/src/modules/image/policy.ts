import type { RasterInfo } from './ports.js';
import { ImageRejectedError } from './errors.js';

export interface ImageWorkerLimits {
	maxSourceBytes: number;
	maxOutputBytes: number;
	maxTempBytes: number;
	maxWidth: number;
	maxHeight: number;
	maxPixels: number;
	maxDecodedBytes: number;
	maxPdfPages: number;
	pdfTimeoutMs: number;
	commandOutputBytes: number;
}

export const DEFAULT_IMAGE_WORKER_LIMITS: ImageWorkerLimits = {
	maxSourceBytes: 100 * 1024 * 1024,
	maxOutputBytes: 32 * 1024 * 1024,
	maxTempBytes: 256 * 1024 * 1024,
	maxWidth: 12_000,
	maxHeight: 12_000,
	maxPixels: 24_000_000,
	maxDecodedBytes: 96 * 1024 * 1024,
	maxPdfPages: 100,
	pdfTimeoutMs: 30_000,
	commandOutputBytes: 64 * 1024,
};

export function assertRasterPolicy(info: RasterInfo, limits: ImageWorkerLimits): void {
	if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height)
		|| info.width < 1 || info.height < 1 || info.width > limits.maxWidth || info.height > limits.maxHeight) {
		throw new ImageRejectedError('Image dimensions exceed policy', 'DIMENSION_LIMIT');
	}
	const pixels = info.width * info.height;
	if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) {
		throw new ImageRejectedError('Decoded image pixel count exceeds policy', 'PIXEL_LIMIT');
	}
	if (info.channels < 1 || info.channels > 4 || pixels * info.channels > limits.maxDecodedBytes) {
		throw new ImageRejectedError('Decoded image memory exceeds policy', 'RESOURCE_LIMIT');
	}
	if (info.pages !== 1) {
		throw new ImageRejectedError('Animated or multipage raster images are not supported',
			info.pages > 1 ? 'ANIMATION_UNSUPPORTED' : 'RASTER_INVALID');
	}
}

export function assertPdfPagePolicy(pages: number, limits: ImageWorkerLimits): void {
	if (!Number.isSafeInteger(pages) || pages < 1 || pages > limits.maxPdfPages) {
		throw new ImageRejectedError('PDF page count exceeds policy', pages < 1 ? 'PDF_INVALID' : 'MULTIPAGE_UNSUPPORTED');
	}
}
