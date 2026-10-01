import { describe, expect, it } from 'vitest';
import { effectiveProjectExternalLinks } from '../shared/project-external-links.js';

describe('effective external links', () => {
	it('uses a safe legacy link only for null or missing storage', () => {
		for (const externalLinks of [null, undefined]) {
			expect(effectiveProjectExternalLinks({ externalLinks, githubUrl: 'https://github.com/pcu/game' })).toEqual([{ label: 'GitHub', url: 'https://github.com/pcu/game' }]);
		}
	});
	it('preserves explicit removal and ordered replacements', () => {
		const links = [{ label: 'Demo', url: 'https://game.test/' }, { label: 'GitHub', url: 'https://github.com/pcu/game' }];
		expect(effectiveProjectExternalLinks({ externalLinks: [], githubUrl: 'https://github.com/pcu/game' })).toEqual([]);
		expect(effectiveProjectExternalLinks({ externalLinks: links })).toEqual(links);
	});
	it.each(['javascript:alert(1)', 'data:text/html,hello', 'ftp://example.test', 'github.com/pcu/game', ''])('hides unsafe legacy value %s', (githubUrl) => {
		expect(effectiveProjectExternalLinks({ githubUrl })).toEqual([]);
	});
	it('does not expose malformed stored JSON or resurrect a legacy link', () => {
		expect(effectiveProjectExternalLinks({ externalLinks: [{ label: 'Bad', url: 'javascript:alert(1)' }], githubUrl: 'https://github.com/pcu/game' })).toEqual([]);
	});
});
