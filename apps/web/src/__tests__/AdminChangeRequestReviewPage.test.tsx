import { env } from '../lib/env';
/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), approve: vi.fn(), reject: vi.fn(), retry: vi.fn() }));
vi.mock('../lib/api', () => ({
  adminChangeRequestApi: mocks,
  getApiErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));
import AdminChangeRequestReviewPage from '../pages/admin/AdminChangeRequestReviewPage';

const request = {
  id: '123e4567-e89b-42d3-a456-426614174000', projectId: 3, originalProjectId: 3, projectTitle: '닫힌 연도 작품', actorId: 1,
  kind: 'EDIT' as const, state: 'PENDING' as const, reason: '오타 수정', reviewReason: null, reviewerId: null, error: null, baseVersion: 1,
  createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z', submittedAt: '2026-09-09T00:00:00.000Z', reviewedAt: null, completedAt: null,
  before: { assets: [], currentWebglDeploymentId: null }, changes: { title: '수정 제목' }, stagingProjectId: null, submissionId: null, items: [], stagedAssets: [],
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('AdminChangeRequestReviewPage', () => {
  it('sends approval and a required rejection reason through the review API', async () => {
    mocks.get.mockResolvedValue(request);
    mocks.approve.mockResolvedValue({ ...request, state: 'APPLYING' });
    mocks.reject.mockResolvedValue({ ...request, state: 'REJECTED' });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={['/admin/change-requests/123e4567-e89b-42d3-a456-426614174000']}><Routes><Route path="/admin/change-requests/:id" element={<AdminChangeRequestReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
    await screen.findByText('수정 제목');
    fireEvent.click(screen.getByRole('button', { name: '승인 및 반영' }));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith(request.id));
    fireEvent.change(screen.getByLabelText('반려 사유 *'), { target: { value: '자료 보완 필요' } });
    fireEvent.click(screen.getByRole('button', { name: '반려' }));
    await waitFor(() => expect(mocks.reject).toHaveBeenCalledWith(request.id, '자료 보완 필요'));
  });

  it('shows old file names and staged previews, while a conflict never exposes retry', async () => {
    mocks.get.mockResolvedValue({ ...request, state: 'CONFLICT', before: { ...request.before, title: '기존 제목', members: [{ name: '기존 학생', studentId: '20200001' }], assets: [{ id: 7, kind: 'IMAGE', originalName: 'old.png' }] }, changes: { title: '수정 제목', members: [], removeAssetIds: [7], removeWebgl: true }, stagedAssets: [{ id: 8, kind: 'IMAGE', originalName: 'new.png', previewUrl: '/api/assets/8/download' }] });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={['/admin/change-requests/123e4567-e89b-42d3-a456-426614174000']}><Routes><Route path="/admin/change-requests/:id" element={<AdminChangeRequestReviewPage />} /></Routes></MemoryRouter></QueryClientProvider>);
    await screen.findByText('기존 제목');
    expect(screen.getByText(/old\.png.*삭제 예정/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /new\.png.*미리보기/ }).getAttribute('href')).toBe(`${env.API_BASE_URL}/api/assets/8/download`);
    expect(screen.getByRole('link', { name: /new\.png.*미리보기/ }).getAttribute('referrerpolicy')).toBe('origin');
    expect(screen.getAllByText('없음').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '반영 재시도' })).toBeNull();
  });
});
