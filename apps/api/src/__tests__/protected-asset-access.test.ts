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
			status: opts.status ?? 'DRAFT',
			members: (opts.memberIds ?? []).map((userId) => ({ userId })),
		},
	};
}

describe('canStreamProtectedAsset', () => {
	it('allows public game and video assets for published and archived projects', () => {
		expect(canStreamProtectedAsset(asset({ kind: 'GAME', status: 'PUBLISHED' }))).toBe(true);
		expect(canStreamProtectedAsset(asset({ kind: 'VIDEO', status: 'ARCHIVED' }))).toBe(true);
	});

	it('does not expose draft protected assets anonymously', () => {
		expect(canStreamProtectedAsset(asset({ status: 'DRAFT' }))).toBe(false);
	});

	it('allows draft asset access to creator, linked member, and privileged roles', () => {
		expect(canStreamProtectedAsset(asset({ creatorId: 1 }), { id: 1, role: 'USER' })).toBe(true);
		expect(canStreamProtectedAsset(asset({ memberIds: [2] }), { id: 2, role: 'USER' })).toBe(true);
		expect(canStreamProtectedAsset(asset({}), { id: 99, role: 'OPERATOR' })).toBe(true);
		expect(canStreamProtectedAsset(asset({}), { id: 99, role: 'ADMIN' })).toBe(true);
	});

	it('blocks unrelated users from draft protected assets', () => {
		expect(canStreamProtectedAsset(asset({ creatorId: 1, memberIds: [2] }), { id: 3, role: 'USER' })).toBe(false);
	});
});
