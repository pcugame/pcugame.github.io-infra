import type { AssetKind } from '@prisma/client';

/** Raw file part collected from multipart stream */
export interface CollectedFile {
  tmpPath: string;
  fieldname: string;
  filename: string;
}

/** Result of validating a file's type and size */
export interface ValidatedFile {
  mimeType: string;
  ext: string;
  sizeBytes: number;
}

/** A file that has been fully processed and moved to permanent storage */
export interface SavedFile {
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  kind: AssetKind;
}
