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

	it('renders a placeholder when posterUrl is missing', () => {
		render(<ProjectCard project={project({ title: 'No Poster' })} year={2026} />);

		expect(screen.getByText('N')).toBeTruthy();
	});
});
