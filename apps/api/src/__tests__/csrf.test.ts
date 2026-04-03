import { describe, it, expect } from 'vitest';
import { validateCsrfOrigin } from '../plugins/csrf.js';
import { AppError } from '../shared/errors.js';

const allowed = new Set(['https://pcugame.github.io', 'http://localhost:5173']);

describe('validateCsrfOrigin', () => {
	// ── Safe methods: always pass ─────────────────────────────

	it.each(['GET', 'HEAD', 'OPTIONS', 'get', 'options'])(
		'allows %s regardless of headers',
		(method) => {
			expect(() => validateCsrfOrigin(method, undefined, undefined, allowed)).not.toThrow();
		},
	);

	// ── Mutating methods with valid Origin ────────────────────

	it.each(['POST', 'PATCH', 'DELETE', 'PUT'])(
		'allows %s with matching Origin header',
		(method) => {
			expect(() =>
				validateCsrfOrigin(method, 'https://pcugame.github.io', undefined, allowed),
			).not.toThrow();
		},
	);

	it('allows POST with localhost origin in dev', () => {
		expect(() =>
			validateCsrfOrigin('POST', 'http://localhost:5173', undefined, allowed),
		).not.toThrow();
	});

	// ── Mutating methods with invalid Origin ─────────────────

	it('blocks POST with non-allowed Origin', () => {
		try {
			validateCsrfOrigin('POST', 'https://evil.com', undefined, allowed);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
			expect((err as AppError).message).toContain('origin');
			expect((err as AppError).message).toContain('evil.com');
		}
	});

	// ── Fallback to Referer ──────────────────────────────────

	it('allows POST when Origin is missing but Referer matches', () => {
		expect(() =>
			validateCsrfOrigin(
				'POST',
				undefined,
				'https://pcugame.github.io/admin/projects/new',
				allowed,
			),
		).not.toThrow();
	});

	it('blocks POST when Referer origin does not match', () => {
		try {
			validateCsrfOrigin('POST', undefined, 'https://evil.com/attack', allowed);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
			expect((err as AppError).message).toContain('referer');
		}
	});

	it('blocks POST with malformed Referer', () => {
		try {
			validateCsrfOrigin('POST', undefined, 'not-a-url', allowed);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
		}
	});

	// ── No Origin, no Referer ────────────────────────────────

	it('blocks POST when both Origin and Referer are missing', () => {
		try {
			validateCsrfOrigin('POST', undefined, undefined, allowed);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
			expect((err as AppError).message).toContain('missing origin');
		}
	});

	it('blocks DELETE when both Origin and Referer are missing', () => {
		try {
			validateCsrfOrigin('DELETE', undefined, undefined, allowed);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
		}
	});

	// ── Edge: Origin takes precedence over Referer ───────────

	it('uses Origin even if Referer is also present', () => {
		// Valid Origin, invalid Referer → should pass (Origin wins)
		expect(() =>
			validateCsrfOrigin(
				'POST',
				'https://pcugame.github.io',
				'https://evil.com/page',
				allowed,
			),
		).not.toThrow();
	});

	it('rejects invalid Origin even if Referer would be valid', () => {
		try {
			validateCsrfOrigin(
				'POST',
				'https://evil.com',
				'https://pcugame.github.io/page',
				allowed,
			);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
		}
	});
});
