import { useState, type ComponentPropsWithoutRef, type SyntheticEvent } from 'react';
import type { ResponsiveImage as ResponsiveImageData } from '@pcu/contracts';

import { buildImageCandidates, buildSrcSet } from '../../lib/responsive-image';

type NativeImageProps = Omit<
	ComponentPropsWithoutRef<'img'>,
	'src' | 'srcSet' | 'alt' | 'sizes'
>;

export interface ResponsiveImageProps extends NativeImageProps {
	image: ResponsiveImageData;
	alt: string;
	sizes?: string;
}

function normalizeUrl(url: string): string {
	try {
		return new URL(url, document.baseURI).href;
	} catch {
		return url;
	}
}

/** Shared API-backed image renderer. Local ObjectURL previews remain plain img elements. */
export function ResponsiveImage({
	image,
	alt,
	sizes,
	onError,
	...imgProps
}: ResponsiveImageProps) {
	const identity = [
		image.original.url,
		...image.renditions.map((rendition) => `${rendition.profile}:${rendition.url}`),
	].join('|');
	const [originalFallbackFor, setOriginalFallbackFor] = useState<string | null>(null);
	const useOriginalOnly = originalFallbackFor === identity;
	const candidates = buildImageCandidates(image);
	const hasRenditionCandidate = candidates.some((candidate) => candidate.kind === 'rendition');
	const srcSet = useOriginalOnly ? undefined : buildSrcSet(image);

	const handleError = (event: SyntheticEvent<HTMLImageElement>) => {
		const failedUrl = event.currentTarget.currentSrc || event.currentTarget.src;
		const originalFailed = normalizeUrl(failedUrl) === normalizeUrl(image.original.url);
		if (!useOriginalOnly && hasRenditionCandidate && !originalFailed) {
			setOriginalFallbackFor(identity);
		}
		onError?.(event);
	};

	return (
		<img
			{...imgProps}
			src={image.original.url}
			srcSet={srcSet}
			sizes={srcSet ? sizes : undefined}
			alt={alt}
			onError={handleError}
		/>
	);
}
