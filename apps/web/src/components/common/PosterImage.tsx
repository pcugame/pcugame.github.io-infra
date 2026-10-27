import { useState, type ComponentPropsWithoutRef } from 'react';

/** Vote snapshots keep a single URL; the source key stays behind the same file gate. */
export function PosterImage({ src, onError, ...props }: ComponentPropsWithoutRef<'img'>) {
 const [failed, setFailed] = useState<string>();
 let fallback = src;
 if (src && failed === src) {
  try {
   const url = new URL(src);
   const match = /^\/img\/v1\/\d+\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
   if (match) {
    const encoded = match[1]!.replaceAll('-', '+').replaceAll('_', '/');
    const key = new TextDecoder().decode(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)));
    url.pathname = '/' + key.split('/').map(encodeURIComponent).join('/');
    fallback = url.toString();
   }
  } catch { /* Keep the existing placeholder/error behavior for non-gateway URLs. */ }
 }
 return <img {...props} src={fallback} onError={event => {
  if (src && failed !== src) setFailed(src);
  onError?.(event);
 }} />;
}
