/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectSubmissionStatusResponse } from '@pcu/contracts';
import { adminProjectApi } from '../lib/api';
import { DraftSubmissionStatus } from '../features/admin/projects/DraftSubmissionStatus';

vi.mock('../features/auth', () => ({ useMe: () => ({ user: { id: 11, role: 'USER' } }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function setup(state: ProjectSubmissionStatusResponse['items'][number]['state'], disabled = false) {
	const status: ProjectSubmissionStatusResponse = {
		projectId: 7, projectStatus: 'DRAFT', submissionId: 'submission', state: 'PENDING',
		items: [{ id: 'item', kind: 'GAME', slot: 'game', clientToken: 't'.repeat(32), required: true, state }],
	};
	vi.spyOn(adminProjectApi, 'getSubmission').mockResolvedValue(status);
	const finalize = vi.spyOn(adminProjectApi, 'finalizeSubmission').mockResolvedValue({ ...status, state: 'FINALIZING' });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(<QueryClientProvider client={client}><DraftSubmissionStatus projectId={7} disabled={disabled} /></QueryClientProvider>);
	return finalize;
}

it.each(['EXPECTED', 'UPLOADING', 'VERIFYING', 'FAILED', 'CANCELLED'] as const)('does not finalize a submission with a %s item', async (state) => {
	const finalize = setup(state);
	await waitFor(() => expect(adminProjectApi.getSubmission).toHaveBeenCalled());
	const button = screen.getByRole('button', { name: '제출 완료' }) as HTMLButtonElement;
	expect(button.disabled).toBe(true);
	fireEvent.click(button);
	expect(finalize).not.toHaveBeenCalled();
});

it('finalizes ready files and waits for publication instead of announcing success early', async () => {
	const finalize = setup('READY');
	const button = screen.getByRole('button', { name: '제출 완료' }) as HTMLButtonElement;
	await waitFor(() => expect(button.disabled).toBe(false));
	fireEvent.click(button);
	await screen.findByText('제출을 마무리하고 있습니다…');
	expect(finalize).toHaveBeenCalledExactlyOnceWith(7);
	expect(button.disabled).toBe(true);
});

it('requires pending edits to be applied before finalization', async () => {
	const finalize = setup('READY', true);
	await waitFor(() => expect(adminProjectApi.getSubmission).toHaveBeenCalled());
	const button = screen.getByRole('button', { name: '제출 완료' }) as HTMLButtonElement;
	expect(button.disabled).toBe(true);
	fireEvent.click(button);
	expect(finalize).not.toHaveBeenCalled();
});
