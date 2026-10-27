import { createHmac } from 'node:crypto';
import { IMAGE_SOURCE_WIDTHS } from '@pcu/contracts';

export type ImageDeliveryMode = 'legacy' | 'imgproxy';

export function imageDeliveryUrl(origin: string, key: string, width: number): string {
 return `${origin}/img/v1/${width}/${Buffer.from(key).toString('base64url')}`;
}

/** Canonical encoding prevents alternate URLs from bypassing source validation. */
export function parseImageDeliveryPath(path: string): { key: string; width: number } | null {
 const match = /^\/img\/v1\/(\d+)\/([A-Za-z0-9_-]+)$/.exec(path);
 if (!match || String(Number(match[1])) !== match[1] || !IMAGE_SOURCE_WIDTHS.includes(Number(match[1]) as typeof IMAGE_SOURCE_WIDTHS[number])) return null;
 const key = Buffer.from(match[2]!, 'base64url').toString('utf8');
 if (!key || Buffer.byteLength(key) > 1024 || Buffer.from(key).toString('base64url') !== match[2]
  || /[\\\u0000-\u001f\u007f]/.test(key) || key.startsWith('/')
  || key.split('/').some(part => !part || part === '.' || part === '..')) return null;
 return { key, width: Number(match[1]) };
}

export function imageSources(origin: string, key: string, width?: number | null, height?: number | null) {
 if (!width || !height) return [];
 const seen = new Set<number>();
 return IMAGE_SOURCE_WIDTHS.flatMap(target => {
  const actual = Math.min(target, width);
  if (seen.has(actual)) return [];
  seen.add(actual);
  return [{ url: imageDeliveryUrl(origin, key, target), width: actual, height: Math.max(1, Math.round(height * actual / width)) }];
 });
}

export function signedImagePath(bucket: string, key: string, width: number, signingKey: string, salt: string): string {
 // imgproxy's non-HTTP transport expects literal keys, not percent-encoded URLs.
 const source = `s3://${bucket}/${key}`;
 const path = `/rs:fit:${width}:0:0/q:82/${Buffer.from(source).toString('base64url')}.webp`;
 const signature = createHmac('sha256', Buffer.from(signingKey, 'hex'))
  .update(Buffer.from(salt, 'hex')).update(path).digest('base64url');
 return `/${signature}${path}`;
}
