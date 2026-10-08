/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExhibitionSelect from '../components/ExhibitionSelect';
import type { AdminExhibitionItem } from '../contracts';

const items: AdminExhibitionItem[] = [
	{ id: 1, year: 2026, title: '현재 전시', visibility: 'PUBLIC', isUploadEnabled: true, sortOrder: 0, projectCount: 0 },
	{ id: 2, year: 2025, title: '이전 전시', visibility: 'PUBLIC', isUploadEnabled: false, sortOrder: 1, projectCount: 0 },
];
afterEach(cleanup);
describe('exhibition select shared control', () => {
 it('keeps readable year/title/lock labels in native options and returns numeric IDs', () => {
  const changed = vi.fn();
  render(<ExhibitionSelect value={1} onChange={changed} items={items} />);
  const select = screen.getByRole('combobox') as HTMLSelectElement;
  expect(select.value).toBe('1');
  expect(select.selectedOptions[0].textContent).toContain('2026 현재 전시');
  expect(screen.getByRole('option', { name: '2025 이전 전시 업로드 잠김' })).toBeTruthy();
  fireEvent.change(select, { target: { value: '2' } });
  expect(changed).toHaveBeenCalledWith(2);
 });
 it('shows the placeholder for an empty list without selecting an invalid ID', () => {
  const changed = vi.fn();
  const { rerender } = render(<ExhibitionSelect value={1} onChange={changed} items={items} />);
  rerender(<ExhibitionSelect value={null} onChange={changed} items={[]} />);
  expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
  expect(screen.getByRole('option', { name: '전시회를 선택하세요' })).toBeTruthy();
  expect(changed).not.toHaveBeenCalled();
 });
});
