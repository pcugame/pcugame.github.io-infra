import { describe, expect, it } from 'vitest';
import { isAllowedSessionSource } from '../shared/session-origin.js';

const allowed = new Set(['https://pcugame.github.io', 'http://localhost:5173']);

describe('browser session source binding', () => {
	it('accepts the configured frontend Origin header', () => {
		expect(isAllowedSessionSource({ origin: 'https://pcugame.github.io' }, allowed)).toBe(true);
	});

	it('accepts frontend navigations by Referer origin', () => {
		expect(isAllowedSessionSource({
			referer: 'https://pcugame.github.io/projects/7/play',
		}, allowed)).toBe(true);
	});

	it.each([
		[{ origin: 'https://api.example.com' }],
		[{ origin: 'null' }],
		[{ referer: 'https://api.example.com/api/public/webgl/7/' }],
		[{ referer: 'not a url' }],
		[{}],
	])('keeps untrusted or unattributed cookie requests anonymous (%j)', (headers) => {
		expect(isAllowedSessionSource(headers, allowed)).toBe(false);
	});
});
