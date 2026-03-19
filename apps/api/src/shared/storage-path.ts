import crypto from 'node:crypto';
import path from 'node:path';

export function generateStorageKey(ext: string): string {
  const uuid = crypto.randomUUID();
  const safe = ext.replace(/[^a-zA-Z0-9]/g, '');
  return `${uuid}.${safe}`;
}

export function buildStoragePath(root: string, storageKey: string): string {
  // Use first 2 chars of key as subdirectory to avoid huge flat dirs
  const sub = storageKey.slice(0, 2);
  const resolved = path.resolve(root, sub, storageKey);

  // Path traversal guard
  if (!resolved.startsWith(path.resolve(root))) {
    throw new Error('Path traversal detected');
  }

  return resolved;
}
