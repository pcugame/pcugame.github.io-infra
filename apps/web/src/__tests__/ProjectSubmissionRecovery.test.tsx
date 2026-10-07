/* @vitest-environment jsdom */
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
beforeEach(() => { vi.stubEnv('VITE_MOCK', 'true'); mocks.user = { id: 3, role: 'USER', name: 'Student', studentId: '2088099' }; window.sessionStorage.clear(); vi.spyOn(adminExhibitionApi, 'list').mockResolvedValue({ items: [] }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); mocks.navigate.mockReset(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it('clears a restored 404 pointer and unlocks the submission form', async () => {
  window.sessionStorage.setItem(key(), JSON.stringify(saved));
  vi.spyOn(userProjectApi, 'getSubmission').mockRejectedValue(new ApiError(404, 'Not Found', null));
  const { result } = setup();
  await waitFor(() => expect(window.sessionStorage.getItem(key())).toBeNull());
  expect(result.current.createdProjectId).toBeNull(); expect(result.current.showGameProgress).toBe(false); expect(result.current.submissionError).toBeNull();
});
it('separates user pointers and ignores an old owner publication result after switching viewers', async () => {
  window.sessionStorage.setItem(key(), JSON.stringify(saved));
  let resolve!: (value: ProjectSubmissionStatusResponse) => void;
  const get = vi.spyOn(userProjectApi, 'getSubmission').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const { result, rerender } = setup(); await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  mocks.user = { ...mocks.user, id: 5 }; rerender();
  await act(async () => resolve({ ...pending, state: 'PUBLISHED', projectStatus: 'PUBLISHED' }));
  expect(result.current.createdProjectId).toBeNull(); expect(mocks.navigate).not.toHaveBeenCalled(); expect(window.sessionStorage.getItem(key())).not.toBeNull();
});
it('stops an old poll on a role flip and after unmount', async () => {
  window.sessionStorage.setItem(key(), JSON.stringify(saved));
  let resolve!: (value: ProjectSubmissionStatusResponse) => void;
  const get = vi.spyOn(userProjectApi, 'getSubmission').mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue({ ...pending, state: 'FINALIZING', publicationState: 'PROCESSING' });
  const { rerender, unmount } = setup(); await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  vi.useFakeTimers(); mocks.user = { ...mocks.user, role: 'ADMIN' }; await act(async () => rerender()); expect(get).toHaveBeenCalledTimes(2);
  await act(async () => resolve({ ...pending, state: 'PUBLISHED', projectStatus: 'PUBLISHED' }));
  expect(mocks.navigate).not.toHaveBeenCalled();
  const calls = get.mock.calls.length; unmount(); await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(get).toHaveBeenCalledTimes(calls);
});
it('shows an explicit publication retry after restoration and publishes through the same finalize action', async () => {
  window.sessionStorage.setItem(key(), JSON.stringify(saved));
  const failed = { ...pending, items: [], state: 'FINALIZING' as const, publicationState: 'FAILED' as const, publicationError: 'Publish failed' };
  const get = vi.spyOn(userProjectApi, 'getSubmission').mockResolvedValue(failed);
  const finalize = vi.spyOn(userProjectApi, 'finalizeSubmission').mockResolvedValue({ ...failed, publicationState: 'PROCESSING' });
  const { result } = setup(); await waitFor(() => expect(result.current.canRetryPublication).toBe(true)); expect(finalize).not.toHaveBeenCalled();
  vi.useFakeTimers(); get.mockResolvedValueOnce(failed).mockResolvedValueOnce({ ...failed, state: 'PUBLISHED', projectStatus: 'PUBLISHED', publicationState: 'COMPLETED' });
  let retry!: Promise<boolean>;
  await act(async () => { retry = result.current.retryPublication() as Promise<boolean>; await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); expect(await retry).toBe(true); });
  expect(finalize).toHaveBeenCalledExactlyOnceWith(7); expect(mocks.navigate).toHaveBeenCalledWith('/admin/projects/7/edit'); expect(window.sessionStorage.getItem(key())).toBeNull();
});

it('keeps an unmounted late metadata success from polling or navigating', async () => {
  let resolve!: (value: SubmitProjectResponse) => void;
  const submit = vi.spyOn(userProjectApi, 'submit').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const get = vi.spyOn(userProjectApi, 'getSubmission').mockResolvedValue(pending);
  const { result, unmount } = setup();
  act(() => result.current.onSubmit({ exhibitionId: 1, title: 'Late submission', members: [{ name: 'Student', studentId: '2088099' }] }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1)); unmount();
  await act(async () => resolve(saved));
  expect(get).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
  expect(window.sessionStorage.getItem(key())).not.toBeNull();
});
it('stops an in-flight publication read as soon as cancel begins', async () => {
  window.sessionStorage.setItem(key(), JSON.stringify(saved));
  let read!: (value: ProjectSubmissionStatusResponse) => void;
  let cancel!: (value: ProjectSubmissionStatusResponse) => void;
  const get = vi.spyOn(userProjectApi, 'getSubmission').mockImplementationOnce(() => new Promise(done => { read = done; }));
  vi.spyOn(userProjectApi, 'cancelSubmission').mockImplementationOnce(() => new Promise(done => { cancel = done; }));
  const finalize = vi.spyOn(userProjectApi, 'finalizeSubmission');
  const { result } = setup(); await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  let deletion!: Promise<void>; act(() => { deletion = result.current.cancelSubmission(); });
  await act(async () => read({ ...pending, items: [], state: 'PUBLISHED', projectStatus: 'PUBLISHED' }));
  expect(finalize).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
  await act(async () => { cancel({ ...pending, state: 'CANCELLED' }); await deletion; });
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('/me/projects');
});
it.each(['success', 'failure'] as const)('ignores old cancellation %s after a viewer change and preserves the new poll', async outcome => {
  window.sessionStorage.setItem(key(), JSON.stringify(saved)); window.sessionStorage.setItem(key(5), JSON.stringify({ ...saved, id: 8 }));
  let cancel!: (value: ProjectSubmissionStatusResponse) => void; let reject!: (error: unknown) => void;
  vi.spyOn(userProjectApi, 'cancelSubmission').mockImplementationOnce(() => new Promise((done, fail) => { cancel = done; reject = fail; }));
  const get = vi.spyOn(userProjectApi, 'getSubmission').mockResolvedValueOnce(pending).mockResolvedValue({ ...pending, projectId: 8, state: 'FINALIZING', publicationState: 'PROCESSING' });
  const { result, rerender, unmount } = setup(); await waitFor(() => expect(result.current.createdProjectId).toBe(7));
  let deletion!: Promise<void>; act(() => { deletion = result.current.cancelSubmission(); });
  vi.useFakeTimers(); mocks.user = { ...mocks.user, id: 5 }; await act(async () => rerender());
  await act(async () => { if (outcome === 'success') cancel({ ...pending, state: 'CANCELLED' }); else reject(new Error('Late cancellation error')); await deletion; });
  expect(result.current.createdProjectId).toBe(8); expect(result.current.submissionError).toBeNull(); expect(mocks.navigate).not.toHaveBeenCalled();
  const calls = get.mock.calls.length; await act(async () => vi.advanceTimersByTimeAsync(1500)); expect(get.mock.calls.length).toBeGreaterThan(calls);
  expect(window.sessionStorage.getItem(key(5))).not.toBeNull(); unmount();
});

it('clears only the exact real API missing-submission 400 error', async () => {
  window.sessionStorage.setItem(key(), JSON.stringify(saved));
  vi.spyOn(userProjectApi, 'getSubmission').mockRejectedValue(new ApiError(400, 'Bad Request', { ok: false, error: { code: 'ERROR', message: 'Project submission not found' } }));
  const { result } = setup(); await waitFor(() => expect(window.sessionStorage.getItem(key())).toBeNull()); expect(result.current.showGameProgress).toBe(false);
});
it('retains the pointer for other validation failures', async () => {
  window.sessionStorage.setItem(key(), JSON.stringify(saved));
  vi.spyOn(userProjectApi, 'getSubmission').mockRejectedValue(new ApiError(400, 'Bad Request', { ok: false, error: { code: 'ERROR', message: 'Invalid project identifier' } }));
  const { result } = setup(); await waitFor(() => expect(result.current.submissionError).not.toBeNull()); expect(result.current.createdProjectId).toBe(7); expect(window.sessionStorage.getItem(key())).not.toBeNull();
});
it('keeps production failed publication behavior unchanged without offering mock restart', async () => {
  vi.stubEnv('VITE_MOCK', 'false'); window.sessionStorage.setItem(key(), JSON.stringify(saved));
  vi.spyOn(userProjectApi, 'getSubmission').mockResolvedValue({ ...pending, items: [], state: 'FINALIZING', publicationState: 'FAILED' });
  const finalize = vi.spyOn(userProjectApi, 'finalizeSubmission'); const { result } = setup();
  await waitFor(() => expect(result.current.submissionError).not.toBeNull()); expect(result.current.canRetryPublication).toBe(false); expect(result.current.canRetryStatus).toBe(false);
  await act(async () => result.current.retryPublication()); expect(finalize).not.toHaveBeenCalled();
});
it.each([0, 429, 503])('offers a GET-only status retry after a transient %s read failure', async code => {
  vi.stubEnv('VITE_MOCK', 'false'); window.sessionStorage.setItem(key(), JSON.stringify(saved));
  const get = vi.spyOn(userProjectApi, 'getSubmission').mockRejectedValueOnce(new ApiError(code, 'Temporary failure', null)).mockResolvedValue(pending);
  const finalize = vi.spyOn(userProjectApi, 'finalizeSubmission'); const { result } = setup();
  await waitFor(() => expect(result.current.canRetryStatus).toBe(true));
  await act(async () => result.current.retryStatus()); expect(get).toHaveBeenCalledTimes(2); expect(finalize).not.toHaveBeenCalled(); expect(result.current.submissionError).toBeNull(); expect(result.current.canRetryStatus).toBe(false);
});

it('rejects an old metadata callback after switching away and returning to the same identity', async () => {
  let resolve!: (value: SubmitProjectResponse) => void;
  const submit = vi.spyOn(userProjectApi, 'submit').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const get = vi.spyOn(userProjectApi, 'getSubmission').mockResolvedValue(pending); const { result, rerender } = setup();
  act(() => result.current.onSubmit({ exhibitionId: 1, title: 'Old lifetime', members: [{ name: 'Student', studentId: '2088099' }] }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  mocks.user = { ...mocks.user, role: 'ADMIN' }; rerender(); mocks.user = { ...mocks.user, role: 'USER' }; rerender();
  await act(async () => resolve(saved)); expect(result.current.createdProjectId).toBeNull(); expect(get).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
});


it('preserves a newer recovery pointer when an old page metadata response arrives last', async () => {
  let resolve!: (value: SubmitProjectResponse) => void;
  const submit = vi.spyOn(userProjectApi, 'submit').mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const get = vi.spyOn(userProjectApi, 'getSubmission').mockResolvedValue({ ...pending, projectId: 8 });
  const old = setup();
  act(() => old.result.current.onSubmit({ exhibitionId: 1, title: 'Old page', members: [{ name: 'Student', studentId: '2088099' }] }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1)); old.unmount();
  window.sessionStorage.setItem(key(), JSON.stringify({ ...saved, id: 8 }));
  const next = setup(); await waitFor(() => expect(next.result.current.createdProjectId).toBe(8));
  await act(async () => resolve(saved));
  expect(JSON.parse(window.sessionStorage.getItem(key())!).id).toBe(8);
  expect(next.result.current.createdProjectId).toBe(8);expect(get).toHaveBeenCalledTimes(1);expect(mocks.navigate).not.toHaveBeenCalled();
});
