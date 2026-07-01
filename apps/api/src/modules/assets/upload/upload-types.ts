import type { AssetKind } from '../../../generated/prisma/client.js';
import type { AssetPlaybackStatus } from '../../../generated/prisma/client.js';

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
  playbackStorageKey?: string | null;
  mimeType: string;
  playbackMimeType?: string;
  sizeBytes: number;
  playbackSizeBytes?: number;
  playbackStatus?: AssetPlaybackStatus;
  playbackError?: string;
  originalName: string;
  kind: AssetKind;
}
