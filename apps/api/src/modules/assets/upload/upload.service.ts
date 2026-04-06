import { promises as fsp } from 'node:fs';
import { createReadStream } from 'node:fs';
import type { AssetKind } from '@prisma/client';
import { logger } from '../../../lib/logger.js';
import { bucketForKind } from '../../../lib/s3.js';
import { uploadFile, deleteObject } from '../../../lib/storage.js';
import { generateStorageKey } from '../../../shared/storage-path.js';
import { validateFile } from './file-validator.js';
import { processImage } from './image-processing.js';
import type { SavedFile } from './upload-types.js';

interface CommittedFile {
  bucket: string;
  storageKey: string;
}

/**
 * Manages the lifecycle of uploaded files through the pipeline:
 *   validate → image-process → move to permanent storage
 *
 * Tracks both temp files and committed (permanently stored) files so that
 * failures at any stage can be cleaned up properly.
 *
 * Usage:
 *   const pipeline = new UploadPipeline();
 *   try {
 *     pipeline.trackTempFile(tmpPath);
 *     const saved = await pipeline.processFile(tmpPath, 'IMAGE', 'photo.jpg');
 *     // ... DB work ...
 *   } catch (err) {
 *     await pipeline.rollbackCommitted();
 *     throw err;
 *   } finally {
 *     await pipeline.cleanupTemp();
 *   }
 */
export class UploadPipeline {
  private tempFiles: string[] = [];
  private committedFiles: CommittedFile[] = [];

  /** Register a temp file so it is cleaned up in the finally block. */
  trackTempFile(tmpPath: string): void {
    this.tempFiles.push(tmpPath);
  }

  /**
   * Full pipeline for a single file:
   *   1. Validate file type (magic bytes) and size
   *   2. Image processing hook (passthrough now; webp conversion later)
   *   3. Move to permanent storage
   *
   * On success the file is moved to permanent storage and tracked for
   * potential rollback.  The temp entry is removed from tracking.
   */
  async processFile(
    tmpPath: string,
    kind: AssetKind,
    originalName: string,
  ): Promise<SavedFile> {
    // ── Step 1: Validate type and size ──────────────────────────
    const validated = await validateFile(tmpPath, kind);

    // ── Step 2: Image processing hook ───────────────────────────
    // Game files (ZIP) skip image processing entirely.
    let finalTmpPath = tmpPath;
    let finalMimeType = validated.mimeType;
    let finalExt = validated.ext;
    let finalSizeBytes = validated.sizeBytes;

    if (kind !== 'GAME' && kind !== 'VIDEO') {
      const processed = await processImage({
        tmpPath,
        mimeType: validated.mimeType,
        ext: validated.ext,
        sizeBytes: validated.sizeBytes,
      });

      finalTmpPath = processed.tmpPath;
      finalMimeType = processed.mimeType;
      finalExt = processed.ext;
      finalSizeBytes = processed.sizeBytes;

      // If conversion created a new file, track it for cleanup.
      // The original tmpPath stays tracked — cleanupTemp handles it.
      if (processed.converted && processed.tmpPath !== tmpPath) {
        this.trackTempFile(processed.tmpPath);
      }
    }

    // ── Step 3: Upload to S3 ─────────────────────────────────────
    const bucket = bucketForKind(kind);
    const storageKey = generateStorageKey(finalExt);
    const stat = await fsp.stat(finalTmpPath);
    const body = createReadStream(finalTmpPath);

    await uploadFile(bucket, storageKey, body, finalMimeType, stat.size);

    // Track the committed file for rollback, remove moved path from temp
    this.committedFiles.push({ bucket, storageKey });
    this.removeTempEntry(finalTmpPath);

    // If no conversion happened, finalTmpPath === tmpPath, so the original
    // is already removed above.  If conversion happened, the original is
    // still tracked and will be cleaned up in cleanupTemp().

    return {
      storageKey,
      mimeType: finalMimeType,
      sizeBytes: finalSizeBytes,
      originalName,
      kind,
    };
  }

  /**
   * Roll back all files that were moved to permanent storage.
   * Call this when a subsequent operation (e.g., DB transaction) fails.
   *
   * Errors during rollback are logged but never thrown, so the original
   * error is always preserved.
   */
  async rollbackCommitted(): Promise<void> {
    for (const f of this.committedFiles) {
      try {
        await deleteObject(f.bucket, f.storageKey);
      } catch (err) {
        logger.error({ err, storageKey: f.storageKey }, 'Upload rollback cleanup failed');
      }
    }
    this.committedFiles = [];
  }

  /** Clean up any remaining temp files.  Always call in a finally block. */
  async cleanupTemp(): Promise<void> {
    for (const t of this.tempFiles) {
      await fsp.unlink(t).catch(() => {});
    }
    this.tempFiles = [];
  }

  // ── Internal ────────────────────────────────────────────────────

  private removeTempEntry(filePath: string): void {
    const idx = this.tempFiles.indexOf(filePath);
    if (idx !== -1) this.tempFiles.splice(idx, 1);
  }
}
