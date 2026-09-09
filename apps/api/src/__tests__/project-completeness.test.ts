import { describe, expect, it } from 'vitest';
import { effectiveIsIncomplete } from '../shared/project-completeness.js';

describe('effectiveIsIncomplete', () => {
	const readyPoster = { kind: 'POSTER' as const, status: 'READY', storageKey: 'poster.webp' };

	it('never marks a project incomplete when the DB flag is false', () => {
		expect(effectiveIsIncomplete(false, [], null)).toBe(false);
	});

	it('clears an imported incomplete flag when game, video, and safe poster are present', () => {
		expect(effectiveIsIncomplete(
			true,
			[{ kind: 'GAME' }, { kind: 'VIDEO' }],
			readyPoster,
		)).toBe(false);
	});

	it('keeps incomplete when a core asset is missing', () => {
		expect(effectiveIsIncomplete(true, [{ kind: 'GAME' }], readyPoster)).toBe(true);
		expect(effectiveIsIncomplete(true, [{ kind: 'VIDEO' }], readyPoster)).toBe(true);
	});

	it('keeps incomplete when the poster is not render-safe', () => {
		expect(effectiveIsIncomplete(
			true,
			[{ kind: 'GAME' }, { kind: 'VIDEO' }],
			{ kind: 'GAME', status: 'READY', storageKey: 'game.zip' },
		)).toBe(true);
		expect(effectiveIsIncomplete(
			true,
			[{ kind: 'GAME' }, { kind: 'VIDEO' }],
			{ kind: 'POSTER', status: 'DELETED', storageKey: 'poster.webp' },
		)).toBe(true);
	});
});
