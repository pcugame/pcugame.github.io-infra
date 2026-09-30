/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const mocks = vi.hoisted(() => ({ create: vi.fn().mockResolvedValue({ id: 1, year: 2026, visibility: 'STAFF' }) }));
vi.mock('../features/auth', () => ({ useMe: () => ({ user: { id: 1, role: 'OPERATOR' }, isPending: false }) }));
vi.mock('../lib/api', () => ({ adminExhibitionApi: { list: async () => ({ items: [] }), create: mocks.create }, adminExportApi: { status: vi.fn(), run: vi.fn() }, isApiError: () => false, getApiErrorMessage: String }));
import AdminYearsPage from '../pages/admin/AdminYearsPage';
vi.mock('../lib/env', () => ({ env: { VISIBILITY_CONTROLS_ENABLED: true } }));
import { VisibilityNotice, VisibilitySelect } from '../components/VisibilitySelect';
afterEach(cleanup);
describe('visibility controls', () => {
 it('blocks exhibition creation until the form selection is explicit and sends that value', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminYearsPage /></QueryClientProvider>);
  const button = await screen.findByRole('button', { name: '추가' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(mocks.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox', { name: '공개 범위' }), { target: { value: 'STAFF' } });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'STAFF' })));
  client.clear();
 });
 it('requires an explicit exhibition choice and shows all shared labels', () => {
  render(<VisibilitySelect defaultValue="" required />);
  expect((screen.getByRole('combobox') as HTMLSelectElement).checkValidity()).toBe(false);
  expect(screen.getByRole('option', { name: '전체 공개' })).toBeTruthy();
  expect(screen.getByRole('option', { name: '로그인 사용자' })).toBeTruthy();
  expect(screen.getByRole('option', { name: '운영자·관리자' })).toBeTruthy();
 });
 it('explains the effective exhibition restriction only when it is stricter', () => {
  const { rerender } = render(<VisibilityNotice visibility="PUBLIC" exhibitionVisibility="STAFF" />);
  expect(screen.getByText(/전시회의 공개 범위/)).toBeTruthy();
  rerender(<VisibilityNotice visibility="STAFF" exhibitionVisibility="AUTHENTICATED" />);
  expect(screen.queryByText(/전시회의 공개 범위/)).toBeNull();
 });
});
