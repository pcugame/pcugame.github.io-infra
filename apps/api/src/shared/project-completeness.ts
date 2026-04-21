/**
 * Decide whether a project should still surface the "incomplete" badge.
 *
 * The DB flag `isIncomplete` is set to `true` during legacy imports (when files
 * weren't attached yet) and is intentionally sticky — nothing clears it
 * automatically when assets land later. Rather than back-fill the flag on every
 * asset mutation (fragile across bulk ops / direct DB writes), serializers
 * override it when the project visibly has its three core media:
 *
 *   - at least one READY GAME asset
 *   - at least one READY VIDEO asset
 *   - a poster that `isPosterUrlSafe` would render
 *
 * Returns the *effective* value the frontend should show. If the DB flag is
 * already false, this is always false.
 */

import type { AssetKind } from '@prisma/client';
import { isPosterUrlSafe } from './poster-validation.js';

export function effectiveIsIncomplete(
	dbIsIncomplete: boolean,
	assets: { kind: AssetKind }[],
	poster: { kind: AssetKind; status: string; storageKey: string } | null,
): boolean {
	if (!dbIsIncomplete) return false;

	const hasGame = assets.some((a) => a.kind === 'GAME');
	const hasVideo = assets.some((a) => a.kind === 'VIDEO');
	const hasPoster = isPosterUrlSafe(poster);

	return !(hasGame && hasVideo && hasPoster);
}
