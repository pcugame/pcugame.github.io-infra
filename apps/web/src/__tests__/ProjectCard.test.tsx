/* @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectCard } from '../components/project/ProjectCard';
import type { PublicProjectCard } from '../contracts';

function project(overrides: Partial<PublicProjectCard> = {}): PublicProjectCard {
	return {
		id: 1,
		slug: 'test-game',
		title: 'Test Game',
		summary: 'A playable project',
		members: [{ name: 'Student', studentId: '2026001' }],
		...overrides,
	};
}

describe('ProjectCard', () => {
	it('renders project information and calls onSelect with the slug', () => {
		const onSelect = vi.fn();
		render(<ProjectCard project={project()} year={2026} onSelect={onSelect} />);

		screen.getByRole('heading', { name: 'Test Game' });
		screen.getByText('A playable project');
		screen.getByText('2026001 Student').closest('button')?.click();

		expect(onSelect).toHaveBeenCalledWith('test-game');
	});

	it('renders a placeholder when the poster is missing', () => {
		render(<ProjectCard project={project({ title: 'No Poster' })} year={2026} />);

		expect(screen.getByText('N')).toBeTruthy();
	});

	it('renders responsive poster candidates with card loading semantics', () => {
		render(<ProjectCard project={project({
			poster: {
				original: {
					url: 'https://images.test/original.webp',
					width: 1200,
					height: 1680,
				},
				renditions: [{
					profile: 'CARD_480',
					url: 'https://images.test/card.webp',
					width: 480,
					height: 672,
				}],
			},
		})} year={2026} />);

		const poster = screen.getByRole('img', { name: 'Test Game 포스터' });
		expect(poster.getAttribute('src')).toBe('https://images.test/original.webp');
		expect(poster.getAttribute('srcset')).toContain('https://images.test/card.webp 480w');
		expect(poster.getAttribute('sizes')).toContain('280px');
		expect(poster.getAttribute('loading')).toBe('lazy');
		expect(poster.getAttribute('decoding')).toBe('async');
	});
});
