/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectSubmissionStatusResponse } from '@pcu/contracts';
import { adminProjectApi } from '../lib/api';
import { userProjectApi } from '../lib/api/me';
import { DraftSubmissionStatus } from '../features/admin/projects/DraftSubmissionStatus';

const viewer = vi.hoisted(() => ({ user: { id: 11, role: 'ADMIN' } }));
vi.mock('../features/auth', () => ({ useMe: () => ({ user: viewer.user }) }));
beforeEach(() => { vi.stubEnv('VITE_MOCK', 'true'); viewer.user = { id: 11, role: 'ADMIN' }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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

it('offers publication retry after a failed finalizing job is restored', async () => {
  const failed: ProjectSubmissionStatusResponse = { submissionId: 'submission', projectId: 7, projectStatus: 'DRAFT', state: 'FINALIZING', publicationState: 'FAILED', publicationError: 'Publication failed', items: [] };
  vi.spyOn(adminProjectApi, 'getSubmission').mockResolvedValue(failed);
  const finalize = vi.spyOn(adminProjectApi, 'finalizeSubmission').mockResolvedValue({ ...failed, publicationState: 'PROCESSING' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DraftSubmissionStatus projectId={7} disabled={false} /></QueryClientProvider>);
  const button = await screen.findByRole('button', { name: 'Mock 발행 다시 시도' }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button); await screen.findByText('제출을 마무리하고 있습니다…'); expect(finalize).toHaveBeenCalledExactlyOnceWith(7);
});

it('uses the authenticated student submission API for an owner draft', async () => {
  viewer.user = { id: 3, role: 'USER' };
  const ready: ProjectSubmissionStatusResponse = { submissionId: 'submission', projectId: 7, projectStatus: 'DRAFT', state: 'PENDING', items: [] };
  const read = vi.spyOn(userProjectApi, 'getSubmission').mockResolvedValue(ready);
  const finalize = vi.spyOn(userProjectApi, 'finalizeSubmission').mockResolvedValue({ ...ready, state: 'FINALIZING' });
  const admin = vi.spyOn(adminProjectApi, 'getSubmission');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DraftSubmissionStatus projectId={7} disabled={false} /></QueryClientProvider>);
  const button = screen.getByRole('button', { name: '제출 완료' }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button); await waitFor(() => expect(finalize).toHaveBeenCalledExactlyOnceWith(7));
  expect(read).toHaveBeenCalledWith(7); expect(admin).not.toHaveBeenCalled();
});

it('does not offer failed publication restart in production', async () => {
  vi.stubEnv('VITE_MOCK', 'false');
  vi.spyOn(adminProjectApi, 'getSubmission').mockResolvedValue({ submissionId: 'submission', projectId: 7, projectStatus: 'DRAFT', state: 'FINALIZING', publicationState: 'FAILED', items: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DraftSubmissionStatus projectId={7} disabled={false} /></QueryClientProvider>);
  await waitFor(() => expect(adminProjectApi.getSubmission).toHaveBeenCalled()); expect(screen.queryByRole('button', { name: 'Mock 발행 다시 시도' })).toBeNull(); expect((screen.getByRole('button', { name: '제출 완료' }) as HTMLButtonElement).disabled).toBe(true);
});
