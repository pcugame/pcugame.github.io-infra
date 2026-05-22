import { promises as fsp } from 'node:fs';
import { createReadStream } from 'node:fs';
import type { AssetKind } from '@prisma/client';
import { logger } from '../../../lib/logger.js';
import { bucketForKind } from '../../../lib/s3.js';
import { uploadFile, deleteObject } from '../../../lib/storage.js';
import { generateStorageKey } from '../../../shared/storage-path.js';
import { validateFile } from './file-validator.js';
import { processImage } from './image-processing.js';
import { processPdf } from './pdf-processing.js';
import { processVideo } from './video-processing.js';
import { badRequest } from '../../../shared/errors.js';
import { storageOptionsForAsset } from './storage-policy.js';
import type { SavedFile } from './upload-types.js';

interface CommittedFile {
  bucket: string;
  storageKey: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Manages the lifecycle of uploaded files through the pipeline:
 *   validate → image/video-process → upload to permanent storage
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
   *   3. Upload to permanent storage
   *
   * On success the file is uploaded to permanent storage and tracked for
   * potential rollback.  The temp entry is removed from tracking.
   */
  async processFile(
    tmpPath: string,
    kind: AssetKind,
    originalName: string,
  ): Promise<SavedFile> {
    // ── Step 1: Validate type and size ──────────────────────────
    const validated = await validateFile(tmpPath, kind);
    const bucket = bucketForKind(kind);

    if (kind === 'VIDEO') {
      const playback = await processVideo({
        tmpPath,
        mimeType: validated.mimeType,
        ext: validated.ext,
        sizeBytes: validated.sizeBytes,
      });
      if (playback.playbackStatus === 'FAILED') {
        throw badRequest(`Video validation failed: ${playback.playbackError || 'unsupported or corrupt video'}`);
      }

      const storageKey = generateStorageKey(validated.ext);
      const originalStat = await fsp.stat(tmpPath);
      await uploadFile(
        bucket,
        storageKey,
        createReadStream(tmpPath),
        validated.mimeType,
        originalStat.size,
        storageOptionsForAsset(kind, 'original'),
      );
      this.committedFiles.push({ bucket, storageKey });

      let playbackStorageKey: string | null = null;
      let playbackMimeType = '';
      let playbackSizeBytes = 0;
      let playbackStatus = playback.playbackStatus;
      let playbackError = playback.playbackError;

      if (playback.playback) {
        this.trackTempFile(playback.playback.tmpPath);
        const candidatePlaybackKey = generateStorageKey(playback.playback.ext);
        try {
          await uploadFile(
            bucket,
            candidatePlaybackKey,
            createReadStream(playback.playback.tmpPath),
            playback.playback.mimeType,
            playback.playback.sizeBytes,
            storageOptionsForAsset(kind, 'playback'),
          );
          playbackStorageKey = candidatePlaybackKey;
          this.committedFiles.push({ bucket, storageKey: playbackStorageKey });
          playbackMimeType = playback.playback.mimeType;
          playbackSizeBytes = playback.playback.sizeBytes;
        } catch (err) {
          logger().error({
            err,
            storageKey,
            playbackStorageKey: candidatePlaybackKey,
            playbackError: errorMessage(err).slice(0, 2000),
          }, 'Playback upload failed');
          throw err;
        }
      }

      return {
        storageKey,
        playbackStorageKey,
        mimeType: validated.mimeType,
        playbackMimeType,
        sizeBytes: validated.sizeBytes,
        playbackSizeBytes,
        playbackStatus,
        playbackError,
        originalName,
        kind,
      };
    }

    // ── Step 2: Image processing hook ───────────────────────────
    // Game files (ZIP) skip image processing entirely.
    let finalTmpPath = tmpPath;
    let finalMimeType = validated.mimeType;
    let finalExt = validated.ext;
    let finalSizeBytes = validated.sizeBytes;

    if ((kind === 'IMAGE' || kind === 'POSTER') && validated.mimeType === 'application/pdf') {
      const processed = await processPdf({ tmpPath });

      finalTmpPath = processed.tmpPath;
      finalMimeType = processed.mimeType;
      finalExt = processed.ext;
      finalSizeBytes = processed.sizeBytes;

      if (processed.tmpPath !== tmpPath) {
        this.trackTempFile(processed.tmpPath);
      }
    } else if (kind !== 'GAME') {
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

      if (processed.converted && processed.tmpPath !== tmpPath) {
        this.trackTempFile(processed.tmpPath);
      }
    }

    // ── Step 3: Upload to S3 ─────────────────────────────────────
    const storageKey = generateStorageKey(finalExt);
    const stat = await fsp.stat(finalTmpPath);
    const body = createReadStream(finalTmpPath);

    await uploadFile(
      bucket,
      storageKey,
      body,
      finalMimeType,
      stat.size,
      storageOptionsForAsset(kind, 'original'),
    );

    // Track the committed file for rollback. Temp files remain tracked and
    // are removed by cleanupTemp() after DB work succeeds or fails.
    this.committedFiles.push({ bucket, storageKey });

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
        logger().error({ err, storageKey: f.storageKey }, 'Upload rollback cleanup failed');
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

}
