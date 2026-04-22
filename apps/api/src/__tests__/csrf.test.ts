import { describe, it, expect } from 'vitest';
import { validateCsrfOrigin } from '../plugins/csrf.js';
import { AppError } from '../shared/errors.js';

const allowed = new Set(['https://pcugame.github.io', 'http://localhost:5173']);

describe('validateCsrfOrigin', () => {
	// ── Safe methods: always pass ─────────────────────────────

	it.each(['GET', 'HEAD', 'OPTIONS', 'get', 'options'])(
		'allows %s regardless of headers',
		(method) => {
			expect(() => validateCsrfOrigin(method, undefined, allowed)).not.toThrow();
		},
	);

	// ── Mutating methods with valid Origin ────────────────────

	it.each(['POST', 'PATCH', 'DELETE', 'PUT'])(
		'allows %s with matching Origin header',
		(method) => {
			expect(() =>
				validateCsrfOrigin(method, 'https://pcugame.github.io', allowed),
			).not.toThrow();
		},
	);

	it('allows POST with localhost origin in dev', () => {
		expect(() =>
			validateCsrfOrigin('POST', 'http://localhost:5173', allowed),
		).not.toThrow();
	});

	// ── Mutating methods with invalid Origin ─────────────────

	it('blocks POST with non-allowed Origin', () => {
		try {
			validateCsrfOrigin('POST', 'https://evil.com', allowed);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
			expect((err as AppError).message).toContain('origin');
			expect((err as AppError).message).toContain('evil.com');
		}
	});

	// ── Missing Origin ───────────────────────────────────────

	it('blocks POST when Origin is missing', () => {
		try {
			validateCsrfOrigin('POST', undefined, allowed);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
			expect((err as AppError).message).toContain('missing origin');
		}
	});

	it('blocks DELETE when Origin is missing', () => {
		try {
			validateCsrfOrigin('DELETE', undefined, allowed);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
		}
	});

	it('blocks POST even when a matching Referer-like header would be present (Referer is ignored)', () => {
		// Origin absent → reject, regardless of any other header a caller might forge.
		try {
			validateCsrfOrigin('POST', undefined, allowed);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(AppError);
			expect((err as AppError).statusCode).toBe(403);
		}
	});
});
