/* @vitest-environment jsdom */
import './helpers/dialog';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminProjectDetail } from '@pcu/contracts';
import AdminProjectEditPage from '../pages/admin/AdminProjectEditPage';
import { adminProjectApi, authApi, publicApi } from '../lib/api';
import { api, ApiError } from '../lib/api/client';
import { FileAccessRenewal } from '../lib/query/FileAccessRenewal';
import { queryKeys } from '../lib/query';

const media = (token: string) => ({ original: { url: `https://files.test/file/${token.repeat(64)}/poster.webp`, width: 480, height: 672 }, renditions: [] });
const initial = (): AdminProjectDetail => ({ visibility: 'STAFF', exhibitionVisibility: 'PUBLIC', canChangeVisibility: true, id: 7, title: '기존 제목', summary: '소개', description: '설명', slug: 'project', year: 2026, platforms: [], isIncomplete: false, video: null, videos: [], status: 'PUBLISHED', sortOrder: 0, canEdit: true, members: [], assets: [], poster: media('a') });
const session = (id: number) => ({ authenticated: true as const, user: { id, role: 'ADMIN' as const, name: `사용자 ${id}`, email: `user${id}@test.invalid`, studentId: undefined } });
let client: QueryClient;
let stored: AdminProjectDetail;
function mount() {
 client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
 client.setQueryData(queryKeys.me, session(1));
 const router = createMemoryRouter([{ path: '/admin/projects/:id/edit', element: <AdminProjectEditPage /> }], { initialEntries: ['/admin/projects/7/edit'] });
 render(<QueryClientProvider client={client}><FileAccessRenewal /><RouterProvider router={router} /></QueryClientProvider>);
 return router;
}
const value = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
async function resume() {
 await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
}
beforeEach(() => {
 Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
 stored = initial();
 vi.spyOn(adminProjectApi, 'getDetail').mockImplementation(async id => ({ ...stored, id }));
 vi.spyOn(adminProjectApi, 'update').mockImplementation(async (_id, body) => ({ ...stored, ...body }));
 vi.spyOn(authApi, 'me').mockResolvedValue(session(1));
 vi.spyOn(publicApi, 'getUploadConfig').mockResolvedValue({ materialMaxCount: 3, materialMaxBytes: 1024 } as Awaited<ReturnType<typeof publicApi.getUploadConfig>>);
 vi.spyOn(api, 'get').mockResolvedValue([]);
 vi.spyOn(api, 'post').mockRejectedValue(new ApiError(401, 'Expired token', null));
});
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); });

describe('project drafts across file access renewal with the real editor and QueryClient', () => {
 it.each([401, 503])('preserves text and member drafts through renewal failure (%s), tab resume and fresh server metadata/media', async status => {
  vi.mocked(api.post).mockRejectedValue(new ApiError(status, 'Renewal failed', null));
  mount(); await screen.findByLabelText('작품명 *');
  change('작품명 *', '내 초안'); change('상세 설명 선택', '작성 중인 설명');
  fireEvent.click(screen.getByRole('navigation', { name: '작품 작성 단계' }).querySelectorAll('button')[1]!);
  fireEvent.click(screen.getByRole('button', { name: '＋ 학생 추가' }));
  change('참여 학생 1 이름', '작성 중인 학생');
  stored = { ...stored, title: '서버 제목', description: '서버 설명', poster: media('b') };
  await resume();
  await waitFor(() => expect(document.querySelector(`img[src="${media('b').original.url}"]`)).not.toBeNull());
  expect(value('작품명 *')).toBe('내 초안'); expect(value('상세 설명 선택')).toBe('작성 중인 설명');
  expect(value('참여 학생 1 이름')).toBe('작성 중인 학생');
  expect(api.post).toHaveBeenCalledWith(`/api/file-access/${'a'.repeat(64)}/renew`);
  expect(adminProjectApi.getDetail).toHaveBeenCalledTimes(2);
 });
 it('retains the draft through a failed refresh and restores it on retry without stale media or submission controls', async () => {
  mount(); await screen.findByLabelText('작품명 *'); change('작품명 *', '보존할 초안');
  vi.mocked(adminProjectApi.getDetail).mockRejectedValueOnce(new Error('일시적 연결 실패'));
  await resume(); await screen.findByRole('alert');
  expect(document.querySelector('img')).toBeNull(); expect(screen.queryByRole('button', { name: '적용' })).toBeNull();
  stored = { ...stored, title: '서버 변경', poster: media('b') };
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await screen.findByLabelText('작품명 *'); expect(value('작품명 *')).toBe('보존할 초안');
  expect(document.querySelector(`img[src="${media('b').original.url}"]`)).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '적용' }));
  await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledWith(7, { title: '보존할 초안' }));
 });
 it.each([401, 403, 404])('blocks protected media and submission when the detail endpoint denies access (%s)', async status => {
  mount(); await screen.findByLabelText('작품명 *'); change('작품명 *', '비공개 초안');
  vi.mocked(adminProjectApi.getDetail).mockRejectedValue(new ApiError(status, 'Denied', null));
  await resume(); await screen.findByRole('alert');
  expect(document.querySelector('img, video, iframe, form')).toBeNull();
  expect(screen.queryByRole('button', { name: '적용' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  await waitFor(() => expect(adminProjectApi.getDetail).toHaveBeenCalledTimes(3));
  expect(adminProjectApi.update).not.toHaveBeenCalled();
 });
 it('blocks submission after a successful read revokes edit capability', async () => {
  mount();
  await act(async () => { client.setQueryData(queryKeys.me, { ...session(1), user: { ...session(1).user, role: 'USER' } }); });
  await screen.findByLabelText('작품명 *'); change('작품명 *', '학생 초안');
  stored = { ...stored, canEdit: false, canChangeVisibility: false };
  await resume();
  await waitFor(() => expect((screen.getByRole('button', { name: '적용' }) as HTMLButtonElement).disabled).toBe(true));
  expect(value('작품명 *')).toBe('학생 초안');
  fireEvent.submit(document.getElementById('project-edit-7')!);
  await act(async () => {});
  expect(adminProjectApi.update).not.toHaveBeenCalled();
 });
 it('discards the mounted draft on user switches, logout and project navigation', async () => {
  const router = mount(); await screen.findByLabelText('작품명 *'); change('작품명 *', '첫 사용자 초안');
  await act(async () => { client.setQueryData(queryKeys.me, session(2)); });
  await waitFor(() => expect(value('작품명 *')).toBe('기존 제목'));
  change('작품명 *', '둘째 사용자 초안');
  await act(async () => { client.setQueryData(queryKeys.me, { authenticated: false }); });
  await waitFor(() => expect(screen.queryByLabelText('작품명 *')).toBeNull()); expect(document.querySelector('img')).toBeNull();
  await act(async () => { client.setQueryData(queryKeys.me, session(2)); });
  await screen.findByLabelText('작품명 *'); expect(value('작품명 *')).toBe('기존 제목');
  change('작품명 *', '다른 작품에 보이면 안 됨');
  await act(async () => { await router.navigate('/admin/projects/8/edit'); });
  await waitFor(() => expect(value('작품명 *')).toBe('기존 제목'));
  await act(async () => { await router.navigate('/admin/projects/7/edit'); });
  await screen.findByLabelText('작품명 *'); expect(value('작품명 *')).toBe('기존 제목');
 });
});
