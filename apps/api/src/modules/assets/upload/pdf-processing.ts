/**
 * PDF processing pipeline — rasterize the first page of a PDF to WebP.
 *
 * Used only for POSTER uploads. Uses pdf-to-img (pdfjs-dist) to render the
 * first page to a PNG buffer, then pipes through sharp to resize and encode
 * as WebP. Pure JS — no system binaries required.
 */

import { promises as fsp } from 'node:fs';
import { pdf } from 'pdf-to-img';
import sharp from 'sharp';
import { logger } from '../../../lib/logger.js';
import { badRequest } from '../../../shared/errors.js';
import type { ImageProcessingResult } from './image-processing.js';

export interface PdfProcessingInput {
  tmpPath: string;
}

/** Scale factor passed to pdfjs (roughly doubles resolution). */
const PDF_SCALE = 2;

/** Max output dimension (px) — caps rasters from large-format PDFs. */
const MAX_DIMENSION = 2000;

/** WebP output quality (0–100) — matches image-processing.ts for consistency. */
const WEBP_QUALITY = 85;

export async function processPdf(
  input: PdfProcessingInput,
): Promise<ImageProcessingResult> {
  const outputPath = input.tmpPath + '.webp';

  let pngBuf: Buffer;
  try {
    const doc = await pdf(input.tmpPath, { scale: PDF_SCALE });
    if (doc.length < 1) {
      throw new Error('PDF has no pages');
    }
    pngBuf = await doc.getPage(1);
  } catch (err) {
    throw translatePdfError(err);
  }

  try {
    await sharp(pngBuf)
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toFile(outputPath);
  } catch (err) {
    await fsp.unlink(outputPath).catch(() => {});
    throw translatePdfError(err);
  }

  const stat = await fsp.stat(outputPath);

  return {
    tmpPath: outputPath,
    mimeType: 'image/webp',
    ext: 'webp',
    sizeBytes: stat.size,
    converted: true,
  };
}

function translatePdfError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  logger().error({ err }, 'PDF rasterization failed');

  const lower = msg.toLowerCase();
  if (lower.includes('password') || lower.includes('encrypt')) {
    return badRequest('암호화된 PDF는 포스터로 사용할 수 없습니다. 암호를 해제한 후 다시 업로드해주세요.');
  }
  if (
    lower.includes('invalid pdf') ||
    lower.includes('no pages') ||
    lower.includes('missing pdf') ||
    lower.includes('unknown pdf') ||
    lower.includes('corrupt')
  ) {
    return badRequest('PDF 파일을 읽을 수 없습니다. 손상되었거나 지원하지 않는 형식입니다.');
  }
  return badRequest('PDF 변환에 실패했습니다.');
}
