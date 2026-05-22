/**
 * Image processing pipeline — decode and re-encode browser images to WebP.
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

/** WebP output quality (0–100). */
const WEBP_QUALITY = 85;

/** MIME types eligible for WebP conversion. */
const CONVERTIBLE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Process an uploaded image file.
 *
 * Converts JPEG/PNG/WebP files to a fresh WebP output. This forces a decode
 * boundary, strips risky metadata, and avoids serving uploaded image bytes
 * directly even when the source is already small.
 */
export async function processImage(
  input: ImageProcessingInput,
): Promise<ImageProcessingResult> {
  if (!CONVERTIBLE_MIMES.has(input.mimeType)) {
    return { ...input, converted: false };
  }

  const outputPath = input.tmpPath + '.webp';

  await sharp(input.tmpPath)
    .webp({ quality: WEBP_QUALITY })
    .toFile(outputPath);

  const stat = await fsp.stat(outputPath);

  return {
    tmpPath: outputPath,
    mimeType: 'image/webp',
    ext: 'webp',
    sizeBytes: stat.size,
    converted: true,
  };
}
