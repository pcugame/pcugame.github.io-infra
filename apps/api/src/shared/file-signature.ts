export interface FileTypeResult {
  mime: string;
  ext: string;
}

const SIGNATURES: { bytes: number[]; offset: number; mime: string; ext: string }[] = [
  // JPEG
  { bytes: [0xff, 0xd8, 0xff], offset: 0, mime: 'image/jpeg', ext: 'jpg' },
  // PNG
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0, mime: 'image/png', ext: 'png' },
  // WebP (RIFF....WEBP)
  { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, mime: 'image/webp', ext: 'webp' },
  // ZIP (also used for game files)
  { bytes: [0x50, 0x4b, 0x03, 0x04], offset: 0, mime: 'application/zip', ext: 'zip' },
  { bytes: [0x50, 0x4b, 0x05, 0x06], offset: 0, mime: 'application/zip', ext: 'zip' },
  { bytes: [0x50, 0x4b, 0x07, 0x08], offset: 0, mime: 'application/zip', ext: 'zip' },
  // MP4 / MOV (ftyp box — covers mp4, m4v, mov, 3gp)
  { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4, mime: 'video/mp4', ext: 'mp4' },
  // WebM / Matroska (EBML header — covers mkv and webm)
  { bytes: [0x1a, 0x45, 0xdf, 0xa3], offset: 0, mime: 'video/x-matroska', ext: 'mkv' },
  // AVI (RIFF....AVI)
  { bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, mime: 'video/x-msvideo', ext: 'avi' },
  // WMV / ASF
  { bytes: [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11], offset: 0, mime: 'video/x-ms-wmv', ext: 'wmv' },
];

const WEBP_MARKER = [0x57, 0x45, 0x42, 0x50]; // "WEBP" at offset 8
const AVI_MARKER = [0x41, 0x56, 0x49, 0x20];  // "AVI " at offset 8

export function detectFileType(buffer: Buffer): FileTypeResult | null {
  for (const sig of SIGNATURES) {
    if (buffer.length < sig.offset + sig.bytes.length) continue;
    const match = sig.bytes.every((b, i) => buffer[sig.offset + i] === b);
    if (match) {
      // RIFF container: disambiguate WebP vs AVI by marker at offset 8
      if (sig.mime === 'image/webp') {
        if (buffer.length < 12) continue;
        const isWebp = WEBP_MARKER.every((b, i) => buffer[8 + i] === b);
        if (!isWebp) continue;
      }
      if (sig.mime === 'video/x-msvideo') {
        if (buffer.length < 12) continue;
        const isAvi = AVI_MARKER.every((b, i) => buffer[8 + i] === b);
        if (!isAvi) continue;
      }
      return { mime: sig.mime, ext: sig.ext };
    }
  }
  return null;
}

const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const ALLOWED_GAME_MIMES = new Set(['application/zip']);

const ALLOWED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/x-matroska',   // mkv / webm
  'video/x-msvideo',    // avi
  'video/x-ms-wmv',     // wmv
]);

export function isAllowedImageType(result: FileTypeResult): boolean {
  return ALLOWED_IMAGE_MIMES.has(result.mime);
}

export function isAllowedGameType(result: FileTypeResult): boolean {
  return ALLOWED_GAME_MIMES.has(result.mime);
}

export function isAllowedVideoType(result: FileTypeResult): boolean {
  return ALLOWED_VIDEO_MIMES.has(result.mime);
}

// Absolute per-kind size ceilings (applies to all roles).
// Role-based tighter limits are enforced in upload-limits.ts.
export const SIZE_LIMITS = {
  poster: 10 * 1024 * 1024,       // 10 MB
  image: 15 * 1024 * 1024,        // 15 MB
  game: 1024 * 1024 * 1024,       // 1024 MB
  video: 1024 * 1024 * 1024,      // 1024 MB
} as const;
