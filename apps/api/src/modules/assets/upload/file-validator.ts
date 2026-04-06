import { promises as fsp } from 'node:fs';
import type { AssetKind } from '@prisma/client';
import {
  detectFileType,
  isAllowedImageType,
  isAllowedGameType,
  isAllowedVideoType,
  SIZE_LIMITS,
} from '../../../shared/file-signature.js';
import { badRequest } from '../../../shared/errors.js';
import type { ValidatedFile } from './upload-types.js';

const KIND_SIZE_LIMITS: Record<string, number> = {
  GAME: SIZE_LIMITS.game,
  POSTER: SIZE_LIMITS.poster,
  THUMBNAIL: SIZE_LIMITS.poster,
  IMAGE: SIZE_LIMITS.image,
  VIDEO: SIZE_LIMITS.video,
};

/**
 * Validate a file's type (via magic-byte signature) and size against the
 * allowed limits for the given AssetKind.
 *
 * Throws AppError (400) on validation failure.
 */
export async function validateFile(
  tmpPath: string,
  kind: AssetKind,
): Promise<ValidatedFile> {
  const stat = await fsp.stat(tmpPath);
  const sizeBytes = stat.size;

  const limit = KIND_SIZE_LIMITS[kind] ?? SIZE_LIMITS.image;
  if (sizeBytes > limit) {
    throw badRequest(`File too large for kind ${kind}`);
  }

  const fd = await fsp.open(tmpPath, 'r');
  const headerBuf = Buffer.alloc(16);
  await fd.read(headerBuf, 0, 16, 0);
  await fd.close();

  const fileType = detectFileType(headerBuf);
  if (!fileType) throw badRequest('Unsupported file type');

  if (kind === 'GAME') {
    if (!isAllowedGameType(fileType)) throw badRequest('Game file must be a ZIP archive');
  } else if (kind === 'VIDEO') {
    if (!isAllowedVideoType(fileType)) throw badRequest('Video must be MP4 or WebM');
  } else {
    if (!isAllowedImageType(fileType)) throw badRequest('Images must be JPEG, PNG, or WebP');
  }

  return { mimeType: fileType.mime, ext: fileType.ext, sizeBytes };
}
