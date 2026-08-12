import type { SavedImageRendition } from '../../application/upload-ports.js';
import {
	deriveImageRenditionStorageKey,
	IMAGE_RENDITION_PROFILES,
} from '../../shared/responsive-image.js';
import type { DurableDeletionTarget } from '../orphan/outbox.js';

export interface AssetImageRenditionReadiness {
	card480Height: number | null;
	display960Height: number | null;
}

export interface ExhibitionImageRenditionReadiness {
	posterCard480Height: number | null;
	posterDisplay960Height: number | null;
}

function renditionHeights(renditions: readonly SavedImageRendition[]): Map<
	SavedImageRendition['profile'],
	number
> {
	const heights = new Map<SavedImageRendition['profile'], number>();
	for (const rendition of renditions) {
		const definition = IMAGE_RENDITION_PROFILES.find(
			(candidate) => candidate.profile === rendition.profile,
		);
		if (!definition || rendition.width !== definition.width) {
			throw new Error('Image rendition dimensions do not match its profile');
		}
		if (heights.has(rendition.profile)) {
			throw new Error(`Duplicate image rendition profile: ${rendition.profile}`);
		}
		heights.set(rendition.profile, rendition.height);
	}
	return heights;
}

/**
 * Convert uploaded derivative metadata into the owner's durable readiness
 * markers. A null marker means that the deterministic object is not public.
 */
export function assetImageRenditionReadiness(
	renditions: readonly SavedImageRendition[],
): AssetImageRenditionReadiness {
	const heights = renditionHeights(renditions);
	return {
		card480Height: heights.get('CARD_480') ?? null,
		display960Height: heights.get('DISPLAY_960') ?? null,
	};
}

export function exhibitionImageRenditionReadiness(
	renditions: readonly SavedImageRendition[],
): ExhibitionImageRenditionReadiness {
	const heights = renditionHeights(renditions);
	return {
		posterCard480Height: heights.get('CARD_480') ?? null,
		posterDisplay960Height: heights.get('DISPLAY_960') ?? null,
	};
}

/**
 * Deterministic derivatives need no database rows. Deletion deliberately
 * queues every supported profile: deleting a missing object is idempotent and
 * this also cleans bytes left by an interrupted readiness commit.
 */
export function imageRenditionDeletionTargets(
	bucket: string,
	sourceStorageKey: string | null,
	reason: string,
): DurableDeletionTarget[] {
	if (!sourceStorageKey) return [];
	return IMAGE_RENDITION_PROFILES.flatMap((definition) => {
		try {
			return [{
				bucket,
				storageKey: deriveImageRenditionStorageKey(
					sourceStorageKey,
					definition.profile,
				),
				reason,
			}];
		} catch {
			// A derivative whose deterministic key is not a valid S3 object key
			// cannot exist. Legacy originals must remain deletable even when their
			// length or reserved grammar makes one/all profile suffixes underivable.
			return [];
		}
	});
}
