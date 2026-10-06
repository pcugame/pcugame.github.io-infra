/* @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useProjectSubmissionForm } from '../features/project-submission/useProjectSubmissionForm';

vi.mock('../features/auth', () => ({ useMe: () => ({ user: { id: 1, role: 'USER', name: 'Member', studentId: '123' }, isPending: false }) }));
vi.mock('../lib/api', () => ({ adminExhibitionApi: { list: () => Promise.resolve({ items: [] }) }, isApiError: () => false }));
vi.mock('../lib/api/project-submit', () => ({ getProjectSubmitApi: () => ({ getSubmission: () => Promise.resolve({ state: 'PUBLISHED', items: [] }) }) }));
afterEach(() => { cleanup(); window.sessionStorage.clear(); });

function Submission() {
  useProjectSubmissionForm({ mode: 'user', files: { posterFile: null, imageFiles: [], videoFiles: [], documentFiles: [], attachmentFiles: [], gameFile: null, webglFile: null } });
  return <p>Submission</p>;
}

describe('registration completion display review', () => {
  it('takes a normal owner to the shared edit page after publication', async () => {
    window.sessionStorage.setItem('pcu.pending-project-submission:user:1', JSON.stringify({ id: 41, submissionId: 'submission', status: 'DRAFT', items: [] }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/submit']}><Routes><Route path="/submit" element={<Submission />} /><Route path="/admin/projects/41/edit" element={<p>Review display settings</p>} /></Routes></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Review display settings')).toBeTruthy());
    expect(window.sessionStorage.getItem('pcu.pending-project-submission:user:1')).toBeNull();
  });
});
