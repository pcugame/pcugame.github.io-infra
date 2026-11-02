/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Award } from '@pcu/contracts';
import { AwardBadge, ProjectAwards } from '../components/project/AwardBadge';
import { laurelIcons } from '../components/project/awardIcons';
import { ProjectCard } from '../components/project/ProjectCard';

afterEach(cleanup);

it.each(['medal', 'trophy', 'ribbon'] as const)('uses the configured %s icon', builtinKey => {
  const award: Award = { id: 1, name: '대상', sortOrder: 0, builtinKey, assetId: null };
  const { container } = render(<AwardBadge award={award} />);
  expect(screen.getByText('대상')).toBeTruthy();
  expect(container.querySelector('img')?.getAttribute('src')).toBe(`/awards/${builtinKey}.svg`);
  expect(screen.queryByRole('img')).toBeNull();
});

it('shows the configured custom image and retains its name on failure', () => {
  const award: Award = { id: 2, name: '관객상', sortOrder: 1, builtinKey: null, assetId: 42, imageUrl: '/custom.png' };
  const { container, rerender } = render(<AwardBadge award={award} />);
  const image = container.querySelector('img')!;
  expect(image.getAttribute('src')).toBe('/custom.png');
  fireEvent.error(image);
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByText('관객상')).toBeTruthy();
  rerender(<AwardBadge award={{ ...award, imageUrl: '/replacement.png' }} />);
  expect(container.querySelector('img')?.hidden).toBe(false);
});

it.each([undefined, []])('renders no awards for %s', awards => {
  const { container } = render(<ProjectAwards awards={awards} />);
  expect(container.childElementCount).toBe(0);
});

it('keeps card selection working when an award is clicked, without changing its data', () => {
  const awards: Award[] = ['대상', '최우수상', '우수상', '장려상'].map((name, id) => ({
    id, name, sortOrder: id, builtinKey: 'medal', assetId: null,
  }));
  const onSelect = vi.fn();
  render(<ProjectCard year={2026} onSelect={onSelect} project={{ slug: 'test', title: '작품', members: [], awards }} />);
  expect(screen.getByRole('group', { name: '수상 내역' }).textContent).toBe('대상최우수상우수상장려상');
  fireEvent.click(screen.getByText('대상'));
  expect(onSelect).toHaveBeenCalledWith('test');
  expect(awards.map(award => award.name)).toEqual(['대상', '최우수상', '우수상', '장려상']);
});

it.each(laurelIcons)('renders the saved $key color without inferring it from the award name', ({ key, color }) => {
  const award: Award = { id: 1, name: '특별상', sortOrder: 99, builtinKey: key, assetId: null };
  const { container } = render(<AwardBadge award={award} />);
  expect(container.querySelector('svg')?.getAttribute('stroke')).toBe(color);
  expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByText('특별상')).toBeTruthy();
});
