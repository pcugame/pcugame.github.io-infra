import { describe, expect, it } from 'vitest';
import type { PublicProjectCard } from '../contracts';
import { sortProjectsWithPosterFirst } from '../lib/utils';

function project(id: number, poster?: PublicProjectCard['poster']): PublicProjectCard {
	return {
		id,
		slug: `project-${id}`,
		title: `Project ${id}`,
		poster,
		members: [],
	};
}

describe('sortProjectsWithPosterFirst', () => {
	it('moves projects without posters behind projects with posters', () => {
		const sorted = sortProjectsWithPosterFirst([
			project(1),
			project(2, { original: { url: 'https://example.test/poster-2.webp' }, renditions: [] }),
			project(3),
			project(4, { original: { url: 'https://example.test/poster-4.webp' }, renditions: [] }),
		]);

		expect(sorted.map((p) => p.id)).toEqual([2, 4, 1, 3]);
	});

	it('keeps the original order within the same poster group', () => {
		const sorted = sortProjectsWithPosterFirst([
			project(1, { original: { url: 'https://example.test/poster-1.webp' }, renditions: [] }),
			project(2, { original: { url: 'https://example.test/poster-2.webp' }, renditions: [] }),
			project(3),
			project(4),
		]);

		expect(sorted.map((p) => p.id)).toEqual([1, 2, 3, 4]);
	});

	it('returns an empty array when there are no projects', () => {
		expect(sortProjectsWithPosterFirst([])).toEqual([]);
	});

	it('keeps the original order when every project is missing a poster', () => {
		const sorted = sortProjectsWithPosterFirst([
			project(1),
			project(2),
			project(3),
		]);

		expect(sorted.map((p) => p.id)).toEqual([1, 2, 3]);
	});
});
