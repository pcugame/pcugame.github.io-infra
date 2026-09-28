/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  unban: vi.fn(),
}));

vi.mock('../lib/api', () => ({
  adminBannedIpApi: { list: mocks.list, create: mocks.create, unban: mocks.unban },
  getApiErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

import AdminBannedIpsPage from '../pages/admin/AdminBannedIpsPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><AdminBannedIpsPage /></QueryClientProvider>);
}

describe('AdminBannedIpsPage', () => {
  it('previews the normalized CIDR and registers it only after confirmation', async () => {
    mocks.list.mockResolvedValue({ items: [] });
    mocks.create.mockResolvedValue({ id: 2, ip: '2001:db8::/64', reason: 'abuse', createdAt: '2026-09-28T00:00:00.000Z', source: 'MANUAL', active: true, disabledAt: null });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();
    await screen.findByText('차단된 IP가 없습니다.');
    fireEvent.change(screen.getByLabelText('IP 주소 또는 CIDR'), { target: { value: '2001:0db8::1/64' } });
    fireEvent.change(screen.getByLabelText('사유'), { target: { value: 'abuse' } });
    expect(await screen.findByText('2001:db8::/64')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '차단 등록' }));

    await waitFor(() => expect(window.confirm).toHaveBeenCalledWith('보호 자산 다운로드에 2001:db8::/64 대역을 차단하시겠습니까?'));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ ip: '2001:db8::/64', reason: 'abuse' }));
  });

  it('rejects invalid targets and leaves registration unchanged when confirmation is cancelled', async () => {
    mocks.list.mockResolvedValue({ items: [] });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await screen.findByText('차단된 IP가 없습니다.');
    fireEvent.change(screen.getByLabelText('IP 주소 또는 CIDR'), { target: { value: 'example.com:443' } });
    expect(screen.getByRole('alert').textContent).toContain('포트와 호스트명');
    expect((screen.getByRole('button', { name: '차단 등록' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('IP 주소 또는 CIDR'), { target: { value: '192.0.2.77/24' } });
    expect((screen.getByRole('button', { name: '차단 등록' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('사유'), { target: { value: 'abuse' } });
    fireEvent.click(screen.getByRole('button', { name: '차단 등록' }));
    expect(window.confirm).toHaveBeenCalledWith('보호 자산 다운로드에 192.0.2.0/24 대역을 차단하시겠습니까?');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('marks inactive automatic records as ineffective and only offers active records for unban', async () => {
    mocks.list.mockResolvedValue({ items: [
      { id: 1, ip: '203.0.113.0/24', reason: 'old automatic rule', createdAt: '2026-09-01T00:00:00.000Z', source: 'AUTO', active: false, disabledAt: '2026-09-28T00:00:00.000Z' },
      { id: 2, ip: '2001:db8::/32', reason: 'manual block', createdAt: '2026-09-02T00:00:00.000Z', source: 'MANUAL', active: true, disabledAt: null },
    ] });

    renderPage();
    expect((await screen.findAllByText('자동 차단 효력 해제')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: '차단 해제' })).toHaveLength(2); // desktop and mobile active controls
    expect(screen.getAllByText('수동').length).toBeGreaterThan(0);
  });
});
