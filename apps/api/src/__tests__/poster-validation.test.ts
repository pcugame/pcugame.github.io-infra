import { describe, it, expect } from 'vitest';
import { assertValidPosterAsset, isPosterUrlSafe, type PosterCandidate } from '../shared/poster-validation.js';
import { AppError } from '../shared/errors.js';

const projectId = 'proj-1';

function fakeAsset(overrides: Partial<PosterCandidate> = {}): PosterCandidate {
	return {
		id: 'asset-1',
		projectId,
		kind: 'POSTER',
		status: 'READY',
		...overrides,
	};
}

// ── assertValidPosterAsset ──────────────────────────────────

describe('assertValidPosterAsset', () => {
	// Valid cases
	it('accepts POSTER kind in READY status', () => {
		expect(() => assertValidPosterAsset(fakeAsset({ kind: 'POSTER' }), projectId)).not.toThrow();
	});

	it('accepts IMAGE kind in READY status', () => {
		expect(() => assertValidPosterAsset(fakeAsset({ kind: 'IMAGE' }), projectId)).not.toThrow();
	});

	it('accepts THUMBNAIL kind in READY status', () => {
		expect(() => assertValidPosterAsset(fakeAsset({ kind: 'THUMBNAIL' }), projectId)).not.toThrow();
	});

	// Null asset
	it('throws 404 when asset is null', () => {
		try {
			assertValidPosterAsset(null, projectId);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(404);
		}
	});

	// Wrong project
	it('throws 404 when asset belongs to a different project', () => {
		try {
			assertValidPosterAsset(fakeAsset({ projectId: 'other-proj' }), projectId);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(404);
			expect((err as AppError).message).toContain('not found');
		}
	});

	// Invalid kind
	it('throws 400 when asset kind is GAME', () => {
		try {
			assertValidPosterAsset(fakeAsset({ kind: 'GAME' }), projectId);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(400);
			expect((err as AppError).message).toContain('GAME');
			expect((err as AppError).message).toContain('cannot be used as poster');
		}
	});

	// Invalid status
	it('throws 400 when asset status is DELETING', () => {
		try {
			assertValidPosterAsset(fakeAsset({ status: 'DELETING' }), projectId);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(400);
			expect((err as AppError).message).toContain('DELETING');
		}
	});

	it('throws 400 when asset status is DELETED', () => {
		try {
			assertValidPosterAsset(fakeAsset({ status: 'DELETED' }), projectId);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(400);
			expect((err as AppError).message).toContain('DELETED');
		}
	});
});

// ── isPosterUrlSafe ─────────────────────────────────────────

describe('isPosterUrlSafe', () => {
	it('returns true for POSTER kind in READY status', () => {
		expect(isPosterUrlSafe({ kind: 'POSTER', status: 'READY', storageKey: 'k' })).toBe(true);
	});

	it('returns true for IMAGE kind in READY status', () => {
		expect(isPosterUrlSafe({ kind: 'IMAGE', status: 'READY', storageKey: 'k' })).toBe(true);
	});

	it('returns true for THUMBNAIL kind in READY status', () => {
		expect(isPosterUrlSafe({ kind: 'THUMBNAIL', status: 'READY', storageKey: 'k' })).toBe(true);
	});

	it('returns false for null poster', () => {
		expect(isPosterUrlSafe(null)).toBe(false);
	});

	it('returns false for GAME kind', () => {
		expect(isPosterUrlSafe({ kind: 'GAME', status: 'READY', storageKey: 'k' })).toBe(false);
	});

	it('returns false for DELETING status', () => {
		expect(isPosterUrlSafe({ kind: 'POSTER', status: 'DELETING', storageKey: 'k' })).toBe(false);
	});

	it('returns false for DELETED status', () => {
		expect(isPosterUrlSafe({ kind: 'IMAGE', status: 'DELETED', storageKey: 'k' })).toBe(false);
	});
});
