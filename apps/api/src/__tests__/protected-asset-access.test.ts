import { describe, expect, it } from 'vitest';
import { authorizeAssetDelivery } from '../modules/assets/delivery-policy.js';

function asset(opts: {
	kind?: string;
	status?: string;
	creatorId?: number;
	memberIds?: number[];
}) {
	return {
		kind: opts.kind ?? 'GAME',
		project: { visibility: 'PUBLIC' as const, exhibition: { visibility: 'PUBLIC' as const }, changeRequestDraft: null,
			creatorId: opts.creatorId ?? 1,
			status: opts.status ?? 'PUBLISHED',
			members: (opts.memberIds ?? []).map((userId) => ({ userId })),
		},
	};
}

describe('authorizeAssetDelivery', () => {
	it('allows public game and video assets for published and archived projects', () => {
		expect(authorizeAssetDelivery({ action: 'DOWNLOAD_ORIGINAL', asset: asset({ kind: 'GAME', status: 'PUBLISHED' }) })).toBe(true);
		expect(authorizeAssetDelivery({ action: 'DOWNLOAD_ORIGINAL', asset: asset({ kind: 'VIDEO', status: 'ARCHIVED' }) })).toBe(true);
	});

	it('applies the same public visibility policy to image and poster delivery', () => {
		expect(authorizeAssetDelivery({ action: 'DOWNLOAD_ORIGINAL', asset: asset({ kind: 'IMAGE', status: 'PUBLISHED' }) })).toBe(true);
		expect(authorizeAssetDelivery({ action: 'DOWNLOAD_ORIGINAL', asset: asset({ kind: 'POSTER', status: 'ARCHIVED' }) })).toBe(true);
	});

	it('allows authenticated owners, linked members, and privileged roles for non-public legacy statuses', () => {
		expect(authorizeAssetDelivery({ action: 'DOWNLOAD_ORIGINAL', asset: asset({ status: 'LEGACY', creatorId: 1 }), actor: { id: 1, role: 'USER' } })).toBe(true);
		expect(authorizeAssetDelivery({ action: 'DOWNLOAD_ORIGINAL', asset: asset({ status: 'LEGACY', memberIds: [2] }), actor: { id: 2, role: 'USER' } })).toBe(true);
		expect(authorizeAssetDelivery({ action: 'DOWNLOAD_ORIGINAL', asset: asset({ status: 'LEGACY' }), actor: { id: 99, role: 'OPERATOR' } })).toBe(true);
		expect(authorizeAssetDelivery({ action: 'DOWNLOAD_ORIGINAL', asset: asset({ status: 'LEGACY' }), actor: { id: 99, role: 'ADMIN' } })).toBe(true);
		expect(authorizeAssetDelivery({ action: 'DOWNLOAD_ORIGINAL', asset: asset({ status: 'LEGACY', creatorId: 1, memberIds: [2] }), actor: { id: 3, role: 'USER' } })).toBe(false);
	});
});
