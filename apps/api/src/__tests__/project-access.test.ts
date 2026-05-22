import { describe, it, expect } from 'vitest';
import { assertWriteAccess } from '../modules/admin/project-access.js';
import { AppError } from '../shared/errors.js';

describe('assertWriteAccess', () => {
	const creatorId = 1;
	const otherId = 2;

	it('allows ADMIN regardless of ownership or status', () => {
		expect(() => assertWriteAccess('ADMIN', creatorId, otherId)).not.toThrow();
	});

	it('allows OPERATOR regardless of ownership or status', () => {
		expect(() => assertWriteAccess('OPERATOR', creatorId, otherId)).not.toThrow();
	});

	it('allows USER who is the creator on a published project', () => {
		expect(() => assertWriteAccess('USER', creatorId, creatorId)).not.toThrow();
	});

	it('allows USER who is the creator on an archived project', () => {
		expect(() => assertWriteAccess('USER', creatorId, creatorId)).not.toThrow();
	});

	it('blocks USER who is not the creator and not a member', () => {
		try {
			assertWriteAccess('USER', creatorId, otherId);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
			expect((err as AppError).message).toContain('Not project owner');
		}
	});

	it('allows USER who is a linked member on a published project', () => {
		expect(() => assertWriteAccess('USER', creatorId, otherId, { isMember: true })).not.toThrow();
	});

	it('allows USER who is a linked member on an archived project', () => {
		expect(() => assertWriteAccess('USER', creatorId, otherId, { isMember: true })).not.toThrow();
	});
});
