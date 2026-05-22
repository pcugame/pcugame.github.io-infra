import { describe, expect, it } from 'vitest';
import { canStreamProtectedAsset } from '../modules/assets/service.js';

function asset(opts: {
	kind?: string;
	status?: string;
	creatorId?: number;
	memberIds?: number[];
}) {
	return {
		kind: opts.kind ?? 'GAME',
		project: {
			creatorId: opts.creatorId ?? 1,
			status: opts.status ?? 'PUBLISHED',
			members: (opts.memberIds ?? []).map((userId) => ({ userId })),
		},
	};
}

describe('canStreamProtectedAsset', () => {
	it('allows public game and video assets for published and archived projects', () => {
		expect(canStreamProtectedAsset(asset({ kind: 'GAME', status: 'PUBLISHED' }))).toBe(true);
		expect(canStreamProtectedAsset(asset({ kind: 'VIDEO', status: 'ARCHIVED' }))).toBe(true);
	});

	it('allows authenticated owners, linked members, and privileged roles for non-public legacy statuses', () => {
		expect(canStreamProtectedAsset(asset({ status: 'LEGACY', creatorId: 1 }), { id: 1, role: 'USER' })).toBe(true);
		expect(canStreamProtectedAsset(asset({ status: 'LEGACY', memberIds: [2] }), { id: 2, role: 'USER' })).toBe(true);
		expect(canStreamProtectedAsset(asset({ status: 'LEGACY' }), { id: 99, role: 'OPERATOR' })).toBe(true);
		expect(canStreamProtectedAsset(asset({ status: 'LEGACY' }), { id: 99, role: 'ADMIN' })).toBe(true);
		expect(canStreamProtectedAsset(asset({ status: 'LEGACY', creatorId: 1, memberIds: [2] }), { id: 3, role: 'USER' })).toBe(false);
	});
});
