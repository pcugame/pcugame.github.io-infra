/* @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/react';
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
		expect(screen.queryByRole('button', { name: '보관' })).toBeNull();
	});
});
