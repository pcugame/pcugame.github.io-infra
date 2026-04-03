import { describe, it, expect } from 'vitest';
import { assertWriteAccess } from '../modules/admin/project-access.js';
import { AppError } from '../shared/errors.js';

describe('assertWriteAccess', () => {
	const creatorId = 'user-creator';
	const otherId = 'user-other';

	// ── ADMIN / OPERATOR: always allowed ─────────────────────

	it('allows ADMIN regardless of ownership or status', () => {
		expect(() => assertWriteAccess('ADMIN', creatorId, otherId, 'PUBLISHED', { requireDraft: true })).not.toThrow();
	});

	it('allows OPERATOR regardless of ownership or status', () => {
		expect(() => assertWriteAccess('OPERATOR', creatorId, otherId, 'ARCHIVED', { requireDraft: true })).not.toThrow();
	});

	// ── USER: owner + draft checks ──────────────────────────

	it('allows USER who is the creator on DRAFT project', () => {
		expect(() => assertWriteAccess('USER', creatorId, creatorId, 'DRAFT', { requireDraft: true })).not.toThrow();
	});

	it('allows USER who is the creator when requireDraft is false', () => {
		expect(() => assertWriteAccess('USER', creatorId, creatorId, 'PUBLISHED')).not.toThrow();
	});

	it('blocks USER who is not the creator and not a member', () => {
		try {
			assertWriteAccess('USER', creatorId, otherId, 'DRAFT', { requireDraft: true });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
			expect((err as AppError).message).toContain('Not project owner');
		}
	});

	// ── USER: member access ─────────────────────────────────

	it('allows USER who is a linked member on DRAFT project', () => {
		expect(() => assertWriteAccess('USER', creatorId, otherId, 'DRAFT', { requireDraft: true, isMember: true })).not.toThrow();
	});

	it('blocks member on PUBLISHED project when requireDraft is true', () => {
		try {
			assertWriteAccess('USER', creatorId, otherId, 'PUBLISHED', { requireDraft: true, isMember: true });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
			expect((err as AppError).message).toContain('non-draft');
		}
	});

	it('allows member when requireDraft is false', () => {
		expect(() => assertWriteAccess('USER', creatorId, otherId, 'PUBLISHED', { isMember: true })).not.toThrow();
	});

	it('blocks USER creator on PUBLISHED project when requireDraft is true', () => {
		try {
			assertWriteAccess('USER', creatorId, creatorId, 'PUBLISHED', { requireDraft: true });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
			expect((err as AppError).message).toContain('non-draft');
		}
	});

	it('blocks USER creator on ARCHIVED project when requireDraft is true', () => {
		try {
			assertWriteAccess('USER', creatorId, creatorId, 'ARCHIVED', { requireDraft: true });
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
		}
	});

	// ── Default opts ────────────────────────────────────────

	it('defaults requireDraft to false when opts omitted', () => {
		expect(() => assertWriteAccess('USER', creatorId, creatorId, 'PUBLISHED')).not.toThrow();
	});
});
