/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateProjectChangeSchema } from '@pcu/contracts';

const mocks = vi.hoisted(() => ({
  getDetail: vi.fn(), listForProject: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), submit: vi.fn(), cancel: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  adminProjectApi: { getDetail: mocks.getDetail },
  changeRequestApi: { listForProject: mocks.listForProject, get: mocks.get, create: mocks.create, update: mocks.update, submit: mocks.submit, cancel: mocks.cancel },
  getApiErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));
vi.mock('../components/DirectImageUploadWidget', () => ({ default: ({ submissionItems }: { submissionItems: Array<{ id: string }> }) => <div>image upload item {submissionItems[0]?.id}</div> }));
vi.mock('../components/DirectVideoUploadWidget', () => ({ default: () => <div>video uploader</div> }));
vi.mock('../components/GameUploadWidget', () => ({ default: () => <div>game uploader</div> }));
vi.mock('../features/auth', () => ({ useMe: () => ({ user: { id: 1, role: 'USER' } }) }));

import ProjectChangeRequestPage from '../pages/ProjectChangeRequestPage';

const project = {
  id: 9, title: '닫힌 연도 작품', slug: 'closed-project', year: 2025, summary: '요약', description: '설명', githubUrl: '', platforms: ['PC'] as const,
  isIncomplete: false, video: null, videos: [], status: 'PUBLISHED' as const, sortOrder: 0, members: [{ id: 1, name: '학생', studentId: '20200001', sortOrder: 0, userId: 1 }], assets: [], canRequestChange: true,
};

function draft(items: Array<{ id: string; clientToken: string; kind: 'IMAGE'; state: 'EXPECTED' | 'READY' }> = []) {
  return {
    id: '123e4567-e89b-42d3-a456-426614174000', projectId: 9, originalProjectId: 9, projectTitle: project.title, actorId: 1,
    kind: 'EDIT' as const, state: 'DRAFT' as const, reason: '보완 요청', reviewReason: null, reviewerId: null, error: null, baseVersion: 1,
    createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z', submittedAt: null, reviewedAt: null, completedAt: null,
    before: { assets: [], currentWebglDeploymentId: null }, changes: {}, stagingProjectId: items.length ? 99 : null, submissionId: null,
    items: items.map((item) => ({ ...item, slot: 'image:0', required: true })), stagedAssets: [],
  };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ProjectChangeRequestPage', () => {
  it('creates a draft, records a complete manifest before upload, and blocks submission until its item is ready', async () => {
    let active: ReturnType<typeof draft> | null = null;
    mocks.getDetail.mockResolvedValue(project);
    mocks.listForProject.mockImplementation(() => Promise.resolve({ items: active ? [active] : [], total: active ? 1 : 0 }));
    mocks.create.mockImplementation(() => { active = draft(); return Promise.resolve(active); });
    mocks.get.mockImplementation(() => Promise.resolve(active));
    mocks.update.mockImplementation((_id: string, body: { manifest?: Array<{ kind: 'IMAGE'; clientToken: string }> }) => {
      if (body.manifest) active = draft([{ id: 'item-1', clientToken: body.manifest[0]!.clientToken, kind: 'IMAGE', state: 'EXPECTED' }]);
      return Promise.resolve(active);
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={['/me/projects/9/change-request']}><Routes><Route path="/me/projects/:id/change-request" element={<ProjectChangeRequestPage />} /></Routes></MemoryRouter></QueryClientProvider>);
    await screen.findByText('요청 종류');
    fireEvent.change(screen.getByLabelText('요청 사유 *'), { target: { value: '보완 요청' } });
    fireEvent.click(screen.getByRole('button', { name: '요청 작성 시작' }));
    await screen.findByText('기본 정보');
    const imageInput = screen.getByLabelText('이미지');
    fireEvent.change(imageInput, { target: { files: [new File(['image'], 'screen.png', { type: 'image/png' })] } });
    fireEvent.click(screen.getByRole('button', { name: '업로드 준비' }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ manifest: [expect.objectContaining({ kind: 'IMAGE', slot: 'image:0', clientToken: expect.stringMatching(/^[A-Za-z0-9_-]{32,128}$/) })] })));
    const payload = mocks.update.mock.calls.find((call) => Array.isArray(call[1]?.manifest))?.[1];
    expect(UpdateProjectChangeSchema.safeParse(payload).success).toBe(true);
    await screen.findByText('image upload item item-1');
    expect(screen.getByRole('button', { name: '운영자에게 제출' }).hasAttribute('disabled')).toBe(true);
  });

  it('shows another member’s draft read-only so only its requester can change or submit it', async () => {
    const otherDraft = { ...draft(), actorId: 2 };
    mocks.getDetail.mockResolvedValue(project);
    mocks.listForProject.mockResolvedValue({ items: [otherDraft], total: 1 });
    mocks.get.mockResolvedValue(otherDraft);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={['/me/projects/9/change-request']}><Routes><Route path="/me/projects/:id/change-request" element={<ProjectChangeRequestPage />} /></Routes></MemoryRouter></QueryClientProvider>);
    await screen.findByLabelText('제목 *');
    expect(screen.queryByRole('button', { name: '운영자에게 제출' })).toBeNull();
  });
  it('saves the visible edits and selects a newly uploaded poster before submitting', async () => {
    const active = { ...draft(), stagedAssets: [{ id: 88, kind: 'POSTER', originalName: 'new.png', previewUrl: '/api/assets/88/download' }] };
    mocks.getDetail.mockResolvedValue({ ...project, posterAssetId: 7, assets: [{ id: 7, kind: 'POSTER', originalName: 'old.png' }] });
    mocks.listForProject.mockResolvedValue({ items: [active], total: 1 });
    mocks.get.mockResolvedValue(active);
    mocks.update.mockResolvedValue(active);
    mocks.submit.mockResolvedValue({ ...active, state: 'PENDING' });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={['/me/projects/9/change-request']}><Routes><Route path="/me/projects/:id/change-request" element={<ProjectChangeRequestPage />} /></Routes></MemoryRouter></QueryClientProvider>);
    const title = await screen.findByLabelText('제목 *');
    fireEvent.change(title, { target: { value: '보완한 제목' } });
    fireEvent.click(screen.getByRole('button', { name: '운영자에게 제출' }));
    await waitFor(() => expect(mocks.submit).toHaveBeenCalledWith(active.id));
    expect(mocks.update).toHaveBeenCalledWith(active.id, expect.objectContaining({ changes: expect.objectContaining({ title: '보완한 제목', posterAssetId: 88 }) }));
    expect(mocks.update.mock.invocationCallOrder[0]!).toBeLessThan(mocks.submit.mock.invocationCallOrder[0]!);
    expect(UpdateProjectChangeSchema.safeParse(mocks.update.mock.calls[0]![1]).success).toBe(true);
  });

});
