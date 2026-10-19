/* @vitest-environment jsdom */
import { resetDirectUploadTasksForTests } from '../lib/upload/directUploadTask';
afterEach(resetDirectUploadTasksForTests);

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PropsWithChildren } from 'react';
import type { ProjectSubmissionStatusResponse, SubmitProjectResponse } from '../contracts';
import { ApiError, adminExhibitionApi } from '../lib/api';
import { userProjectApi } from '../lib/api/me';
import { useProjectSubmissionForm } from '../features/project-submission/useProjectSubmissionForm';

const mocks = vi.hoisted(() => ({ user: { id: 3, role: 'USER', name: 'Student', studentId: '2088099' }, navigate: vi.fn() }));
vi.mock('../features/auth', () => ({ useMe: () => ({ user: mocks.user, isPending: false }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
const files = { posterFile: null, imageFiles: [], gameFile: null, webglFile: null, videoFiles: [], documentFiles: [], attachmentFiles: [] };
const saved: SubmitProjectResponse = { id: 7, slug: 'pending', year: 2025, status: 'DRAFT', submissionId: 'saved', items: [], adminEditUrl: '/admin/projects/7/edit' };
const pending: ProjectSubmissionStatusResponse = { projectId: 7, projectStatus: 'DRAFT', submissionId: 'saved', state: 'PENDING', items: [{ id: 'item', kind: 'GAME', slot: 'game', clientToken: 'x'.repeat(32), required: true, state: 'EXPECTED' }] };
const key = (userId = 3) => `pcu.pending-project-submission:user:${userId}`;
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook(() => useProjectSubmissionForm({ mode: 'user', files }), { wrapper });
  return { ...hook, client };
}
beforeEach(() => { vi.stubEnv('VITE_MOCK', 'true'); mocks.user = { id: 3, role: 'USER', name: 'Student', studentId: '2088099' }; window.sessionStorage.clear(); window.localStorage.clear(); vi.spyOn(adminExhibitionApi, 'list').mockResolvedValue({ items: [] }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); mocks.navigate.mockReset(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it('restores the saved project in its editor without finalizing or recreating it', async () => {
 window.sessionStorage.setItem(key(), JSON.stringify(saved));
 const get = vi.spyOn(userProjectApi, 'getSubmission').mockResolvedValue(pending);
 const finalize = vi.spyOn(userProjectApi, 'finalizeSubmission');
 const submit = vi.spyOn(userProjectApi, 'submit');
 setup();
 await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/admin/projects/7/edit'));
 expect(get).toHaveBeenCalledOnce(); expect(finalize).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
});
it('clears a deleted project recovery pointer', async () => {
 window.sessionStorage.setItem(key(), JSON.stringify(saved));
 vi.spyOn(userProjectApi, 'getSubmission').mockRejectedValue(new ApiError(404, 'Not Found', null));
 const { result } = setup();
 await waitFor(() => expect(window.sessionStorage.getItem(key())).toBeNull());
 expect(result.current.createdProjectId).toBeNull(); expect(mocks.navigate).not.toHaveBeenCalled();
});
it('preserves the pointer on a transient failure', async () => {
 window.sessionStorage.setItem(key(), JSON.stringify(saved));
 vi.spyOn(userProjectApi, 'getSubmission').mockRejectedValue(new ApiError(503, 'Unavailable', null));
 const { result } = setup();
 await waitFor(() => expect(result.current.submissionError).not.toBeNull());
 expect(window.sessionStorage.getItem(key())).not.toBeNull(); expect(mocks.navigate).not.toHaveBeenCalled();
});
it.each(['viewer', 'unmount'])('ignores a recovery response after %s changes', async change => {
 window.sessionStorage.setItem(key(), JSON.stringify(saved));
 let resolve!: (value: ProjectSubmissionStatusResponse) => void;
 vi.spyOn(userProjectApi, 'getSubmission').mockImplementation(() => new Promise(done => { resolve = done; }));
 const { rerender, unmount } = setup(); await waitFor(() => expect(resolve).toBeDefined());
 if (change === 'unmount') unmount(); else { mocks.user = { ...mocks.user, id: 5 }; rerender(); }
 await act(async () => resolve(pending));
 expect(mocks.navigate).not.toHaveBeenCalled(); expect(window.sessionStorage.getItem(key())).not.toBeNull();
});
it('replays the persisted request and key after a lost creation response', async () => {
 const payload = { exhibitionId: 1, title: 'Saved request', members: [{ name: 'Student', studentId: '1' }], manifest: [] };
 window.localStorage.setItem(`${key()}:create`, JSON.stringify({ key: 'persisted-operation', payload }));
 const submit = vi.spyOn(userProjectApi, 'submit').mockResolvedValue(saved);
 setup();
 await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/admin/projects/7/edit'));
 expect(submit).toHaveBeenCalledOnce();
 expect(submit.mock.calls[0][0].idempotencyKey).toBe('persisted-operation');
 expect(JSON.parse(String(submit.mock.calls[0][0].formData.get('payload')))).toEqual(payload);
 expect(window.localStorage.getItem(`${key()}:create`)).toBeNull();
});
