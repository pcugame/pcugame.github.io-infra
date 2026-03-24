/**
 * Image processing pipeline — automatic WebP conversion for large uploads.
 */

import { promises as fsp } from 'node:fs';
import sharp from 'sharp';

export interface ImageProcessingInput {
  /** Path to the temp file on disk */
  tmpPath: string;
  /** Detected MIME type (e.g., 'image/jpeg') */
  mimeType: string;
  /** Detected file extension (e.g., 'jpg') */
  ext: string;
  /** File size in bytes */
  sizeBytes: number;
}

export interface ImageProcessingResult {
  /** Path to the (possibly converted) file — may differ from input */
  tmpPath: string;
  /** Final MIME type — may change after conversion (e.g., 'image/webp') */
  mimeType: string;
  /** Final file extension — may change after conversion (e.g., 'webp') */
  ext: string;
  /** Final file size in bytes — may change after compression */
  sizeBytes: number;
  /**
   * Whether a conversion was actually performed.
   * When true, the caller should keep the *original* tmpPath tracked for
   * cleanup, because a new intermediate file was created at the returned
   * tmpPath.
   */
  converted: boolean;
}

/** Files above this size (in bytes) are converted to WebP. */
const WEBP_THRESHOLD_BYTES = 512 * 1024; // 512 KB

/** WebP output quality (0–100). */
const WEBP_QUALITY = 85;

/** MIME types eligible for WebP conversion. */
const CONVERTIBLE_MIMES = new Set(['image/jpeg', 'image/png']);

/**
 * Process an uploaded image file.
 *
 * Converts JPEG/PNG files above WEBP_THRESHOLD_BYTES to WebP.
 * Files already in WebP format or below the threshold are returned unchanged.
 */
export async function processImage(
  input: ImageProcessingInput,
): Promise<ImageProcessingResult> {
  if (!CONVERTIBLE_MIMES.has(input.mimeType) || input.sizeBytes <= WEBP_THRESHOLD_BYTES) {
    return { ...input, converted: false };
  }

  const outputPath = input.tmpPath + '.webp';

  await sharp(input.tmpPath)
    .webp({ quality: WEBP_QUALITY })
    .toFile(outputPath);

  const stat = await fsp.stat(outputPath);

  // If WebP is somehow larger than the original, keep the original.
  if (stat.size >= input.sizeBytes) {
    await fsp.unlink(outputPath).catch(() => {});
    return { ...input, converted: false };
  }

  return {
    tmpPath: outputPath,
    mimeType: 'image/webp',
    ext: 'webp',
    sizeBytes: stat.size,
    converted: true,
  };
}
