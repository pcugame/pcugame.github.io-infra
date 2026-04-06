import { describe, it, expect } from 'vitest';
import { assertUploadAllowed } from '../modules/admin/upload-guard.js';
import { AppError } from '../shared/errors.js';
import type { Exhibition } from '@prisma/client';

function fakeExhibition(overrides: Partial<Exhibition> = {}): Exhibition {
	return {
		id: 1,
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
	it('throws 404 when exhibition is null (any role)', () => {
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

	it('allows USER when uploads are enabled', () => {
		const ex = fakeExhibition({ isUploadEnabled: true });
		expect(() => assertUploadAllowed(ex, 2025, 'USER')).not.toThrow();
	});

	it('allows OPERATOR when uploads are enabled', () => {
		const ex = fakeExhibition({ isUploadEnabled: true });
		expect(() => assertUploadAllowed(ex, 2025, 'OPERATOR')).not.toThrow();
	});

	it('allows ADMIN when uploads are enabled', () => {
		const ex = fakeExhibition({ isUploadEnabled: true });
		expect(() => assertUploadAllowed(ex, 2025, 'ADMIN')).not.toThrow();
	});

	it('blocks USER when uploads are disabled', () => {
		const ex = fakeExhibition({ isUploadEnabled: false });
		try {
			assertUploadAllowed(ex, 2025, 'USER');
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
			expect((err as AppError).message).toContain('disabled');
		}
	});

	it('allows OPERATOR when uploads are disabled', () => {
		const ex = fakeExhibition({ isUploadEnabled: false });
		expect(() => assertUploadAllowed(ex, 2025, 'OPERATOR')).not.toThrow();
	});

	it('allows ADMIN when uploads are disabled', () => {
		const ex = fakeExhibition({ isUploadEnabled: false });
		expect(() => assertUploadAllowed(ex, 2025, 'ADMIN')).not.toThrow();
	});
});
