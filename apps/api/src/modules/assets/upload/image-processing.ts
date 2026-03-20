/**
 * Image processing pipeline — extension point for future transformations.
 *
 * Currently implements passthrough (returns the input unchanged).
 * Designed so that adding automatic .webp conversion requires changes
 * only within this file.
 */

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

/*
 * TODO: Implement automatic WebP conversion for large image uploads.
 *
 * ── When to trigger ──────────────────────────────────────────────────
 *   - The uploaded file is JPEG or PNG (mimeType !== 'image/webp').
 *   - Its size exceeds a configurable threshold.
 *     Suggested defaults: 2 MB for IMAGE kind, 5 MB for POSTER kind.
 *     (Define the threshold constant in this file or in file-signature.ts.)
 *
 * ── Conversion flow ──────────────────────────────────────────────────
 *   1. npm install sharp            (add to apps/api)
 *   2. Import sharp in this file.
 *   3. In processImage():
 *        if (mimeType !== 'image/webp' && sizeBytes > threshold) {
 *          const outputPath = input.tmpPath + '.webp';
 *          await sharp(input.tmpPath).webp({ quality: 90 }).toFile(outputPath);
 *          const stat = await fsp.stat(outputPath);
 *          return {
 *            tmpPath: outputPath,
 *            mimeType: 'image/webp',
 *            ext: 'webp',
 *            sizeBytes: stat.size,
 *            converted: true,
 *          };
 *        }
 *   4. Return passthrough for files already WebP or below threshold.
 *
 * ── How the pipeline uses the result ─────────────────────────────────
 *   - upload.service.ts calls generateStorageKey(result.ext), so a
 *     converted file automatically gets a .webp storage key.
 *   - The Asset DB record stores the returned mimeType and sizeBytes,
 *     so metadata stays accurate after conversion.
 *   - When converted === true, the pipeline keeps the original tmpPath
 *     tracked for cleanup and tracks the new tmpPath as well. Both are
 *     cleaned up in the finally block.
 *
 * ── Files that should NOT need changes ───────────────────────────────
 *   - upload.service.ts  (already handles converted flag)
 *   - admin.routes.ts    (uses pipeline unchanged)
 *   - file-validator.ts  (validation happens before processing)
 *   - file-signature.ts  (WebP is already an allowed image type)
 */

/**
 * Process an uploaded image file.
 *
 * Currently a passthrough — returns the input unchanged.
 * See the TODO block above for the planned WebP conversion.
 */
export async function processImage(
  input: ImageProcessingInput,
): Promise<ImageProcessingResult> {
  return { ...input, converted: false };
}
