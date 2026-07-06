import { describe, expect, it, vi } from 'vitest';
import { defaultTestEnv } from './helpers/app-mocks.js';

vi.mock('../config/env.js', () => ({
	env: () => ({
		...defaultTestEnv,
		SESSION_IDLE_MS: 30 * 60 * 1000,
		SESSION_ABSOLUTE_MS: 14 * 24 * 60 * 60 * 1000,
	}),
}));

import {
	absoluteSessionExpiresAt,
	cookieExpiresAt,
	generateSessionId,
	isIdleExpired,
} from '../shared/session.js';

describe('session helpers', () => {
	it('generates opaque 32-byte hex session ids', () => {
		const id = generateSessionId();

		expect(id).toMatch(/^[a-f0-9]{64}$/);
		expect(generateSessionId()).not.toBe(id);
	});

	it('calculates absolute session expiry from the configured window', () => {
		const from = new Date('2026-01-01T00:00:00.000Z');

		expect(absoluteSessionExpiresAt(from).toISOString()).toBe('2026-01-15T00:00:00.000Z');
	});

	it('uses idle expiry for cookies when idle ends before absolute expiry', () => {
		const now = new Date('2026-01-01T00:00:00.000Z');
		const session = { expiresAt: new Date('2026-01-02T00:00:00.000Z') };

		expect(cookieExpiresAt(session, now).toISOString()).toBe('2026-01-01T00:30:00.000Z');
	});

	it('caps cookie expiry at the absolute session expiry', () => {
		const now = new Date('2026-01-01T00:00:00.000Z');
		const session = { expiresAt: new Date('2026-01-01T00:10:00.000Z') };

		expect(cookieExpiresAt(session, now).toISOString()).toBe('2026-01-01T00:10:00.000Z');
	});

	it('treats sessions as idle-expired only after the idle window is exceeded', () => {
		const now = new Date('2026-01-01T00:30:00.000Z');

		expect(isIdleExpired(new Date('2026-01-01T00:00:00.000Z'), now)).toBe(false);
		expect(isIdleExpired(new Date('2025-12-31T23:59:59.999Z'), now)).toBe(true);
	});
});
