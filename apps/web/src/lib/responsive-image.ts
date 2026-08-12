import type { ResponsiveImage } from '@pcu/contracts';

type ResponsiveImageRendition = ResponsiveImage['renditions'][number];

const PROFILE_WIDTH: Record<ResponsiveImageRendition['profile'], number> = {
	CARD_480: 480,
	DISPLAY_960: 960,
};

export type ResponsiveImageCandidate = {
	kind: 'original' | 'rendition';
	profile?: ResponsiveImageRendition['profile'];
	url: string;
	width?: number;
	height?: number;
};

/**
 * Returns a deterministic profile order without mutating the API response.
 * Invalid duplicate rows are kept here so candidate construction can apply
 * profile and width de-duplication in one place.
 */
export function sortImageRenditions(
	renditions: readonly ResponsiveImageRendition[],
): ResponsiveImageRendition[] {
	return [...renditions].sort((a, b) => {
		const profileOrder = PROFILE_WIDTH[a.profile] - PROFILE_WIDTH[b.profile];
		if (profileOrder !== 0) return profileOrder;

		const targetWidth = PROFILE_WIDTH[a.profile];
		const distance = Math.abs(a.width - targetWidth) - Math.abs(b.width - targetWidth);
		if (distance !== 0) return distance;
		if (a.width !== b.width) return a.width - b.width;
		return a.url.localeCompare(b.url);
	});
}

/** Builds the unique browser candidates shared by every image call site. */
export function buildImageCandidates(image: ResponsiveImage): ResponsiveImageCandidate[] {
	const candidates: ResponsiveImageCandidate[] = [];
	const seenProfiles = new Set<ResponsiveImageRendition['profile']>();
	const seenWidths = new Set<number>();
	const seenUrls = new Set<string>();

	for (const rendition of sortImageRenditions(image.renditions)) {
		if (
			seenProfiles.has(rendition.profile) ||
			seenWidths.has(rendition.width) ||
			seenUrls.has(rendition.url)
		) {
			continue;
		}

		seenProfiles.add(rendition.profile);
		seenWidths.add(rendition.width);
		seenUrls.add(rendition.url);
		candidates.push({
			kind: 'rendition',
			profile: rendition.profile,
			url: rendition.url,
			width: rendition.width,
			height: rendition.height,
		});
	}

	if (
		!seenUrls.has(image.original.url) &&
		(image.original.width == null || !seenWidths.has(image.original.width))
	) {
		candidates.push({
			kind: 'original',
			url: image.original.url,
			width: image.original.width,
			height: image.original.height,
		});
	}

	return candidates.sort((a, b) => {
		if (a.width == null) return b.width == null ? 0 : 1;
		if (b.width == null) return -1;
		if (a.width !== b.width) return a.width - b.width;
		return a.kind === b.kind ? 0 : a.kind === 'rendition' ? -1 : 1;
	});
}

export function buildSrcSet(image: ResponsiveImage): string | undefined {
	const entries = buildImageCandidates(image)
		.filter((candidate): candidate is ResponsiveImageCandidate & { width: number } =>
			candidate.width != null,
		)
		.map((candidate) => `${candidate.url} ${candidate.width}w`);

	return entries.length > 0 ? entries.join(', ') : undefined;
}

/**
 * Picks the smallest candidate that can satisfy a target width. If the source
 * itself is smaller than the target, the canonical original is returned.
 */
export function pickRendition(
	image: ResponsiveImage,
	targetWidth: number,
): ResponsiveImageCandidate {
	const original: ResponsiveImageCandidate = {
		kind: 'original',
		url: image.original.url,
		width: image.original.width,
		height: image.original.height,
	};
	const safeTargetWidth = Math.max(1, targetWidth);

	if (image.original.width != null && image.original.width <= safeTargetWidth) {
		return original;
	}

	const candidates = buildImageCandidates(image);
	const sizedCandidates = candidates.filter(
		(candidate): candidate is ResponsiveImageCandidate & { width: number } =>
			candidate.width != null,
	);
	const largeEnough = sizedCandidates.find((candidate) => candidate.width >= safeTargetWidth);
	if (largeEnough) return largeEnough;

	// A legacy original may not have dimensions yet. Prefer it over knowingly
	// undersized renditions when none can satisfy the requested display width.
	if (image.original.width == null) return original;

	return sizedCandidates.at(-1) ?? original;
}
