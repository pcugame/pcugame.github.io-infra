import type {
	Prisma,
} from '../../generated/prisma/client.js';
import type { SavedImageRendition } from '../../application/upload-ports.js';
import type { DurableDeletionTarget } from '../orphan/outbox.js';

export interface StoredImageRenditionIdentity {
	storageKey: string;
	sourceStorageKey: string;
}

type ImageRenditionOwner =
	| { assetId: number; exhibitionId?: never }
	| { assetId?: never; exhibitionId: number };

/**
 * Build the one canonical Prisma representation used by project, exhibition,
 * and backfill transactions. Upload code owns bytes; this helper owns only the
 * shared persistence shape.
 */
export function imageRenditionCreateManyData(
	owner: ImageRenditionOwner,
	sourceStorageKey: string,
	renditions: readonly SavedImageRendition[],
): Prisma.ImageRenditionCreateManyInput[] {
	return renditions.map((rendition) => {
		if (rendition.sourceStorageKey !== sourceStorageKey) {
			throw new Error('Image rendition source does not match its canonical upload');
		}
		return {
			profile: rendition.profile,
			storageKey: rendition.storageKey,
			sourceStorageKey,
			width: rendition.width,
			height: rendition.height,
			mimeType: rendition.mimeType,
			sizeBytes: BigInt(rendition.sizeBytes),
			...owner,
		};
	});
}

/** Only derivatives of the owner's current immutable source are live. */
export function currentImageRenditions<T extends StoredImageRenditionIdentity>(
	sourceStorageKey: string | null,
	renditions: readonly T[],
): T[] {
	if (!sourceStorageKey) return [];
	return renditions.filter((rendition) => (
		rendition.sourceStorageKey === sourceStorageKey
	));
}

export function imageRenditionDeletionTargets(
	bucket: string,
	sourceStorageKey: string | null,
	renditions: readonly StoredImageRenditionIdentity[],
	reason: string,
): DurableDeletionTarget[] {
	return currentImageRenditions(sourceStorageKey, renditions).map((rendition) => ({
		bucket,
		storageKey: rendition.storageKey,
		reason,
	}));
}
