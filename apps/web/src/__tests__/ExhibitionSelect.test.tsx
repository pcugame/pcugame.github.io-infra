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
	it('preserves year, title and lock labels and returns numeric IDs from keyboard selection', () => {
		const changed = vi.fn();
		render(<ExhibitionSelect value={1} onChange={changed} items={items} />);
		const trigger = screen.getByRole('combobox');
		expect(trigger.textContent).toContain('2026현재 전시');
		fireEvent.click(trigger);
		expect(screen.getByRole('option', { name: /2025 이전 전시 업로드 잠김/ })).toBeTruthy();
		fireEvent.keyDown(screen.getByRole('listbox'), { key: 'End' });
		fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
		expect(changed).toHaveBeenCalledWith(2);
		expect(screen.queryByRole('listbox')).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});
	it('handles options removed while the panel is open without an invalid active descendant', () => {
		const changed = vi.fn();
		const { rerender } = render(<ExhibitionSelect value={1} onChange={changed} items={items} />);
		fireEvent.click(screen.getByRole('combobox'));
		fireEvent.keyDown(screen.getByRole('listbox'), { key: 'End' });
		rerender(<ExhibitionSelect value={null} onChange={changed} items={[]} />);
		expect(screen.getByRole('listbox').getAttribute('aria-activedescendant')).toBeNull();
		fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
		expect(changed).not.toHaveBeenCalled();
	});
});
