import { describe, it, expect } from 'vitest';
import { assertUploadAllowed } from '../modules/admin/upload-guard.js';
import { AppError } from '../shared/errors.js';
import type { Year } from '@prisma/client';

function fakeYear(overrides: Partial<Year> = {}): Year {
	return {
		id: 'year-1',
		year: 2025,
		title: '',
		isUploadEnabled: true,
		sortOrder: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

describe('assertUploadAllowed', () => {
	// ── Year existence ──────────────────────────────────────────

	it('throws 404 when year is null (any role)', () => {
		for (const role of ['USER', 'OPERATOR', 'ADMIN'] as const) {
			try {
				assertUploadAllowed(null, 2025, role);
				expect.fail('should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).statusCode).toBe(404);
				expect((err as AppError).message).toContain('2025');
			}
		}
	});

	// ── Upload enabled ──────────────────────────────────────────

	it('allows USER when uploads are enabled', () => {
		const year = fakeYear({ isUploadEnabled: true });
		expect(() => assertUploadAllowed(year, 2025, 'USER')).not.toThrow();
	});

	it('allows OPERATOR when uploads are enabled', () => {
		const year = fakeYear({ isUploadEnabled: true });
		expect(() => assertUploadAllowed(year, 2025, 'OPERATOR')).not.toThrow();
	});

	it('allows ADMIN when uploads are enabled', () => {
		const year = fakeYear({ isUploadEnabled: true });
		expect(() => assertUploadAllowed(year, 2025, 'ADMIN')).not.toThrow();
	});

	// ── Upload disabled ─────────────────────────────────────────

	it('blocks USER when uploads are disabled', () => {
		const year = fakeYear({ isUploadEnabled: false });
		try {
			assertUploadAllowed(year, 2025, 'USER');
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
			expect((err as AppError).message).toContain('disabled');
		}
	});

	it('allows OPERATOR when uploads are disabled', () => {
		const year = fakeYear({ isUploadEnabled: false });
		expect(() => assertUploadAllowed(year, 2025, 'OPERATOR')).not.toThrow();
	});

	it('allows ADMIN when uploads are disabled', () => {
		const year = fakeYear({ isUploadEnabled: false });
		expect(() => assertUploadAllowed(year, 2025, 'ADMIN')).not.toThrow();
	});
});
