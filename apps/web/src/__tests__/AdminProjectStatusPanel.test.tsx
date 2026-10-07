/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminProjectStatusPanel } from '../features/admin/projects/AdminProjectStatusPanel';

describe('AdminProjectStatusPanel', () => {
	afterEach(cleanup);

	it('does not offer direct publication or archival while a submission is DRAFT', () => {
		render(
			<AdminProjectStatusPanel
				status="DRAFT"
				isPrivileged
				isPending={false}
				error={null}
				onToggle={vi.fn()}
			/>,
		);

		expect(screen.getByText('제출 중')).toBeTruthy();
		expect(screen.queryByRole('button', { name: '공개로 전환' })).toBeNull();
		expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
	});
	it.each(['PUBLISHED', 'ARCHIVED'] as const)('toggles %s using the existing status contract', (status) => {
		const onToggle = vi.fn();
		render(
			<AdminProjectStatusPanel
				status={status}
				isPrivileged
				isPending={false}
				error={null}
				onToggle={onToggle}
			/>,
		);
		const toggle = screen.getByRole('switch', { name: '작품 보관' });
		expect(toggle.getAttribute('aria-checked')).toBe(String(status === 'ARCHIVED'));
		expect(toggle.textContent).toBe('일반보관');
		fireEvent.click(toggle);
		expect(onToggle).toHaveBeenCalledWith(status === 'PUBLISHED' ? 'ARCHIVED' : 'PUBLISHED');
	});
	it.each([
		{ isPrivileged: false, isPending: false },
		{ isPrivileged: true, isPending: true },
	])('prevents changes without permission or during saving: %j', (flags) => {
		const onToggle = vi.fn();
		render(<AdminProjectStatusPanel status="PUBLISHED" {...flags} error={null} onToggle={onToggle} />);
		fireEvent.click(screen.getByRole('switch'));
		expect(onToggle).not.toHaveBeenCalled();
	});
});
