import { promises as fsp } from 'node:fs';

/**
 * Move a file across filesystems while preserving rename-like semantics.
 *
 * `rename()` is attempted first for the same-filesystem fast path. If the
 * source and destination are on different devices, fall back to copy + delete.
 */
export async function moveFile(srcPath: string, destPath: string): Promise<void> {
  try {
    await fsp.rename(srcPath, destPath);
    return;
  } catch (error) {
    if (!isExdevError(error)) throw error;
  }

  await fsp.copyFile(srcPath, destPath);

  try {
    await fsp.unlink(srcPath);
  } catch (error) {
    await fsp.unlink(destPath).catch(() => {});
    throw error;
  }
}

function isExdevError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EXDEV';
}
