/**
 * Poster asset validation — pure functions, no DB dependency.
 *
 * A valid poster asset must:
 * - Belong to the target project
 * - Be an image kind (POSTER, IMAGE, or THUMBNAIL — NOT GAME)
 * - Be in READY status
 */

import type { AssetKind } from '@prisma/client';
import { badRequest, notFound } from './errors.js';

const POSTER_ELIGIBLE_KINDS = new Set<AssetKind>(['POSTER', 'IMAGE', 'THUMBNAIL']);

export interface PosterCandidate {
	id: number;
	projectId: number;
	kind: AssetKind;
	status: string;
}

/**
 * Validate that an asset is eligible to be set as a project's poster.
 * Throws descriptive errors on failure.
 */
export function assertValidPosterAsset(
	asset: PosterCandidate | null,
	expectedProjectId: number,
): void {
	if (!asset) {
		throw notFound('Asset not found');
	}

	if (asset.projectId !== expectedProjectId) {
		throw notFound('Asset not found in this project');
	}

	if (!POSTER_ELIGIBLE_KINDS.has(asset.kind)) {
		throw badRequest(
			`Asset kind '${asset.kind}' cannot be used as poster. Only image assets (POSTER, IMAGE, THUMBNAIL) are allowed.`,
		);
	}

	if (asset.status !== 'READY') {
		throw badRequest(
			`Asset is in '${asset.status}' status. Only READY assets can be set as poster.`,
		);
	}
}

/**
 * Check whether an asset loaded via the `poster` relation is safe to
 * generate a public poster URL for.
 *
 * Use this in serializers as a guard against stale or invalid poster refs
 * (e.g., a GAME asset accidentally set as poster, or a since-deleted asset
 * whose FK hasn't been cleaned up yet).
 */
export function isPosterUrlSafe(poster: {
	kind: AssetKind;
	status: string;
	storageKey: string;
} | null): boolean {
	if (!poster) return false;
	if (!POSTER_ELIGIBLE_KINDS.has(poster.kind)) return false;
	if (poster.status !== 'READY') return false;
	return true;
}
