/* @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../lib/api', () => ({ adminChangeRequestApi: mocks }));
import AdminChangeRequestsPage from '../pages/admin/AdminChangeRequestsPage';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('filters with the shared native dropdown and resets pagination when the state changes', async () => {
  mocks.list.mockResolvedValue({ items: [], total: 101 });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><AdminChangeRequestsPage /></MemoryRouter></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: '다음' }));
  await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({ state: 'PENDING', offset: 50, limit: 50 }));
  const trigger = await screen.findByRole('combobox', { name: '상태' });
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['검토 대기', '반영 중', '반영 실패', '충돌']);
  fireEvent.change(trigger, { target: { value: 'CONFLICT' } });
  await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({ state: 'CONFLICT', offset: 0, limit: 50 }));
  expect((await screen.findByRole('combobox', { name: '상태' }) as HTMLSelectElement).value).toBe('CONFLICT');
});
