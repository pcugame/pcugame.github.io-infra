import { describe, it, expect } from 'vitest';
import {
  detectFileType,
  isAllowedImageType,
  isAllowedPosterType,
  isAllowedGameType,
  SIZE_LIMITS,
} from '../shared/file-signature.js';

describe('detectFileType', () => {
  it('detects JPEG', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const result = detectFileType(buf);
    expect(result).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
  });

  it('detects PNG', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
    const result = detectFileType(buf);
    expect(result).toEqual({ mime: 'image/png', ext: 'png' });
  });

  it('detects WebP', () => {
    // RIFF....WEBP
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x00, 0x00, 0x00, 0x00, // file size (don't care)
      0x57, 0x45, 0x42, 0x50, // WEBP
      0x00, 0x00, 0x00, 0x00,
    ]);
    const result = detectFileType(buf);
    expect(result).toEqual({ mime: 'image/webp', ext: 'webp' });
  });

  it('detects ZIP', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const result = detectFileType(buf);
    expect(result).toEqual({ mime: 'application/zip', ext: 'zip' });
  });

  it('detects PDF', () => {
    // "%PDF-1.4..."
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0, 0, 0, 0, 0, 0, 0, 0]);
    const result = detectFileType(buf);
    expect(result).toEqual({ mime: 'application/pdf', ext: 'pdf' });
  });

  it('returns null for unknown', () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(detectFileType(buf)).toBeNull();
  });

  it('detects AVI from RIFF+AVI marker', () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x41, 0x56, 0x49, 0x20, // "AVI "
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(detectFileType(buf)).toEqual({ mime: 'video/x-msvideo', ext: 'avi' });
  });

  it('rejects RIFF without WEBP or AVI marker', () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, // unknown RIFF subtype
      0x00, 0x00, 0x00, 0x00,
    ]);
    expect(detectFileType(buf)).toBeNull();
  });
});

describe('isAllowedImageType', () => {
  it('allows JPEG, PNG, WebP', () => {
    expect(isAllowedImageType({ mime: 'image/jpeg', ext: 'jpg' })).toBe(true);
    expect(isAllowedImageType({ mime: 'image/png', ext: 'png' })).toBe(true);
    expect(isAllowedImageType({ mime: 'image/webp', ext: 'webp' })).toBe(true);
  });

  it('rejects ZIP', () => {
    expect(isAllowedImageType({ mime: 'application/zip', ext: 'zip' })).toBe(false);
  });

  it('rejects PDF (PDF is poster-only)', () => {
    expect(isAllowedImageType({ mime: 'application/pdf', ext: 'pdf' })).toBe(false);
  });
});

describe('isAllowedPosterType', () => {
  it('allows JPEG, PNG, WebP, PDF', () => {
    expect(isAllowedPosterType({ mime: 'image/jpeg', ext: 'jpg' })).toBe(true);
    expect(isAllowedPosterType({ mime: 'image/png', ext: 'png' })).toBe(true);
    expect(isAllowedPosterType({ mime: 'image/webp', ext: 'webp' })).toBe(true);
    expect(isAllowedPosterType({ mime: 'application/pdf', ext: 'pdf' })).toBe(true);
  });

  it('rejects ZIP and video types', () => {
    expect(isAllowedPosterType({ mime: 'application/zip', ext: 'zip' })).toBe(false);
    expect(isAllowedPosterType({ mime: 'video/mp4', ext: 'mp4' })).toBe(false);
  });
});

describe('SIZE_LIMITS', () => {
  it('exposes a larger ceiling for PDF posters than image posters', () => {
    expect(SIZE_LIMITS.posterPdf).toBeGreaterThan(SIZE_LIMITS.poster);
  });
});

describe('isAllowedGameType', () => {
  it('allows ZIP', () => {
    expect(isAllowedGameType({ mime: 'application/zip', ext: 'zip' })).toBe(true);
  });

  it('rejects images', () => {
    expect(isAllowedGameType({ mime: 'image/jpeg', ext: 'jpg' })).toBe(false);
  });
});
