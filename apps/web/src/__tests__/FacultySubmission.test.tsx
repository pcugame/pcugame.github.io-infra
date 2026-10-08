/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '../contracts';
import { adminExhibitionApi, adminProjectApi, publicApi } from '../lib/api';
import { userProjectApi } from '../lib/api/me';
import { isFacultyAccount } from '../features/project-submission/faculty-account';
import { useProjectSubmissionForm } from '../features/project-submission/useProjectSubmissionForm';
import { ProjectSubmissionForm } from '../features/project-submission/ProjectSubmissionForm';

const mocks = vi.hoisted(() => ({ user: undefined as AuthUser | undefined, navigate: vi.fn() }));
vi.mock('../features/auth', () => ({ useMe: () => ({ user: mocks.user }) }));
vi.mock('react-router-dom', async importOriginal => ({ ...(await importOriginal<typeof import('react-router-dom')>()), useNavigate: () => mocks.navigate }));
const faculty: AuthUser = { id: 9, email: 'A00000@pcu.ac.kr', name: '김교원', role: 'ADMIN' };
const files = { posterFile: null, imageFiles: [], videoFiles: [], documentFiles: [], attachmentFiles: [], gameFile: null, webglFile: null };
function wrapper({ children }: PropsWithChildren) { return <MemoryRouter><QueryClientProvider client={client}>{children}</QueryClientProvider></MemoryRouter>; }
let client: QueryClient;
beforeEach(() => {
  mocks.user = { ...faculty };
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.spyOn(adminExhibitionApi, 'list').mockResolvedValue({ items: [] });
  vi.spyOn(publicApi, 'getUploadConfig').mockResolvedValue({ materialMaxCount: 5, materialMaxBytes: 1024 });
  vi.spyOn(adminProjectApi, 'submit').mockImplementation(() => new Promise(() => {}));
  vi.spyOn(userProjectApi, 'submit').mockImplementation(() => new Promise(() => {}));
});
afterEach(() => { cleanup(); client.clear(); window.sessionStorage.clear(); vi.restoreAllMocks(); });

it.each(['A00000@pcu.ac.kr', 'a12345@PCU.AC.KR'])('recognizes the full faculty address %s', email => expect(isFacultyAccount(email)).toBe(true));
it.each([undefined, '', 'A0000@pcu.ac.kr', 'A000000@pcu.ac.kr', 'B00000@pcu.ac.kr', '20260001@pcu.ac.kr', 'A00000@g.pcu.ac.kr', 'A00000@pcu.ac.kr.evil', ' A00000@pcu.ac.kr'])('does not broaden the faculty pattern: %s', email => expect(isFacultyAccount(email)).toBe(false));

describe.each(['USER', 'OPERATOR', 'ADMIN'] as const)('faculty %s', role => {
  it.each(['user', 'admin'] as const)('keeps participants blank and unlinked in %s mode, including same-name students', async mode => {
    mocks.user = { ...faculty, role };
    const { result } = renderHook(() => useProjectSubmissionForm({ mode, files }), { wrapper });
    expect(result.current.form.getValues('members')).toEqual([{ name: '', studentId: '' }]);
    act(() => {
      result.current.form.setValue('members.0.name', faculty.name);
      result.current.form.setValue('members.0.studentId', '20260001');
      result.current.membersFieldArray.append({ name: '다른 학생', studentId: '20260002' });
    });
    act(() => result.current.membersFieldArray.remove(1));
    expect(result.current.form.getValues('members')).toEqual([{ name: faculty.name, studentId: '20260001' }]);
    act(() => result.current.onSubmit({ ...result.current.form.getValues(), exhibitionId: 1, title: 'Faculty upload' }));
    const submit = mode === 'admin' ? adminProjectApi.submit : userProjectApi.submit;
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const payload = JSON.parse(String(vi.mocked(submit).mock.calls[0][0].formData.get('payload')));
    expect(payload.members).toEqual([{ name: faculty.name, studentId: '20260001' }]);
  });
});

it('does not refill a cleared faculty name when rows change or profile data refreshes', () => {
  const { result, rerender } = renderHook(() => useProjectSubmissionForm({ mode: 'admin', files }), { wrapper });
  act(() => { result.current.form.setValue('members.0.name', '입력'); result.current.form.setValue('members.0.name', ''); result.current.membersFieldArray.append({ name: '', studentId: '' }); });
  mocks.user = { ...faculty, studentId: 'legacy-value' }; rerender();
  expect(result.current.form.getValues('members.0')).toEqual({ name: '', studentId: '' });
});

it('keeps late faculty profile data out of a manually entered participant', () => {
  mocks.user = undefined;
  const { result, rerender } = renderHook(() => useProjectSubmissionForm({ mode: 'admin', files }), { wrapper });
  act(() => result.current.form.setValue('members.0.name', '입력한 학생'));
  mocks.user = faculty; rerender();
  expect(result.current.form.getValues('members.0')).toEqual({ name: '입력한 학생', studentId: '' });
});

it.each(['USER', 'ADMIN'] as const)('preserves numeric student defaults for non-faculty %s', role => {
  mocks.user = { ...faculty, role, email: '20260001@pcu.ac.kr', studentId: '20260001' };
  const mode = role === 'ADMIN' ? 'admin' : 'user';
  const { result } = renderHook(() => useProjectSubmissionForm({ mode, files }), { wrapper });
  expect(result.current.form.getValues('members.0')).toEqual({ name: faculty.name, studentId: '20260001', ...(mode === 'admin' ? { userId: 9 } : {}) });
});

it('remounts the entire form and file controls when the signed-in account changes', async () => {
  const { container, rerender } = render(<ProjectSubmissionForm mode="admin" />, { wrapper });
  fireEvent.change(screen.getByLabelText('이름'), { target: { value: '기존 학생' } });
  fireEvent.change(screen.getByLabelText('제목 *'), { target: { value: '이전 계정의 작품' } });
  const oldFileInput = container.querySelector('input[type=file]');
  expect(oldFileInput).not.toBeNull();
  mocks.user = { ...faculty, id: 10, email: 'A00001@pcu.ac.kr' };
  rerender(<ProjectSubmissionForm mode="admin" />);
  expect((screen.getByLabelText('이름') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('제목 *') as HTMLInputElement).value).toBe('');
  expect(container.querySelector('input[type=file]')).not.toBe(oldFileInput);
  await waitFor(() => expect(adminExhibitionApi.list).toHaveBeenCalled());
});


it('restores only the faculty account submission after remount without creating another project', async () => {
  const saved = { id: 73, slug: 'faculty-project', year: 2026, status: 'DRAFT' as const, submissionId: 'faculty-submission', items: [], adminEditUrl: '/admin/projects/73/edit' };
  const item = { id: 'item', kind: 'GAME' as const, slot: 'game', clientToken: 'x'.repeat(32), required: true as const, state: 'EXPECTED' as const };
  const get = vi.spyOn(adminProjectApi, 'getSubmission').mockResolvedValue({ projectId: 73, projectStatus: 'DRAFT', submissionId: saved.submissionId, state: 'PENDING', items: [item] });
  window.sessionStorage.setItem('pcu.pending-project-submission:admin:9', JSON.stringify(saved));
  const first = renderHook(() => useProjectSubmissionForm({ mode: 'admin', files }), { wrapper });
  await waitFor(() => expect(first.result.current.createdProjectId).toBe(73));
  first.unmount();
  const second = renderHook(() => useProjectSubmissionForm({ mode: 'admin', files }), { wrapper });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(second.result.current.createdProjectId).toBe(73);
  expect(second.result.current.form.getValues('members')).toEqual([{ name: '', studentId: '' }]);
  expect(adminProjectApi.submit).not.toHaveBeenCalled();
});
