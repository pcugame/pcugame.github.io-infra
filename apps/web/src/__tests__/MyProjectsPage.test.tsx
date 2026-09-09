/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn(), delete: vi.fn(), listMine: vi.fn() }));
vi.mock('../lib/api', () => ({
  adminProjectApi: { list: mocks.list, delete: mocks.delete },
  changeRequestApi: { listMine: mocks.listMine },
}));
import MyProjectsPage from '../pages/MyProjectsPage';

function renderPage() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><MyProjectsPage /></MemoryRouter></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('MyProjectsPage capabilities', () => {
  it('routes a closed-year contributor to the request flow and does not offer direct edit', async () => {
    mocks.list.mockResolvedValue({ items: [{ id: 3, title: '닫힌 작품', slug: 'closed', year: 2025, isIncomplete: false, status: 'PUBLISHED', memberNames: [], memberStudentIds: [], updatedAt: '2026-09-09T00:00:00.000Z', canEdit: false, canDelete: false, canRequestChange: true }], pagination: {} });
    mocks.listMine.mockResolvedValue({ items: [{ id: 'request-1', projectId: 3, originalProjectId: 3, projectTitle: '닫힌 작품', kind: 'EDIT', state: 'PENDING', updatedAt: '2026-09-09T00:00:00.000Z' }], total: 1 });
    renderPage();
    const link = await screen.findByRole('link', { name: '변경 요청' });
    expect(link.getAttribute('href')).toBe('/me/projects/3/change-request');
    expect(screen.queryByRole('link', { name: '수정' })).toBeNull();
    expect(screen.getByText(/변경 요청 이력/)).toBeTruthy();
  });

  it('only deletes after confirmation and refreshes the list after success', async () => {
    mocks.list.mockResolvedValue({ items: [{ id: 4, title: '열린 작품', slug: 'open', year: 2026, isIncomplete: false, status: 'PUBLISHED', memberNames: [], memberStudentIds: [], updatedAt: '2026-09-09T00:00:00.000Z', canEdit: true, canDelete: true, canRequestChange: true }], pagination: {} });
    mocks.listMine.mockResolvedValue({ items: [], total: 0 });
    mocks.delete.mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await screen.findAllByText('열린 작품');
    fireEvent.click(screen.getAllByRole('button', { name: '삭제' })[0]!);
    expect(mocks.delete).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getAllByRole('button', { name: '삭제' })[0]!);
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith(4));
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(1));
  });
});
