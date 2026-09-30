/* @vitest-environment jsdom */
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileAccessRenewal } from '../lib/query/FileAccessRenewal';
import { api } from '../lib/api/client';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe('active file capability renewal', () => {
 it('reacquires media after expired renewal when a suspended tab resumes', async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fresh = { webglUrl: 'https://files.test/play/new/index.html' };
  const fetchFresh = vi.fn().mockResolvedValue(fresh);
  const observer = new QueryObserver(client, { queryKey: ['projectDetailById', 2], queryFn: fetchFresh, initialData: { webglUrl: 'https://files.test/play/expired/index.html' }, staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => undefined);
  vi.spyOn(api, 'post').mockRejectedValue(new Error('expired'));
  render(<QueryClientProvider client={client}><FileAccessRenewal /></QueryClientProvider>);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); });
  expect(fetchFresh).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(['projectDetailById', 2])).toEqual(fresh);
  unsubscribe();
  client.clear();
 });
 it('renews the same WebGL token at 30 seconds and stops after the screen unmounts', async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const client = new QueryClient();
  const data = { webglUrl: 'https://files.test/play/stable/index.html' };
  const observer = new QueryObserver(client, { queryKey: ['projectDetailById', 1], queryFn: async () => data, initialData: data, staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => undefined);
  const renew = vi.spyOn(api, 'post').mockResolvedValue({ url: data.webglUrl, token: 'stable', expiresAt: 'later' });
  const screen = render(<QueryClientProvider client={client}><FileAccessRenewal /></QueryClientProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(renew).toHaveBeenCalledWith('/api/file-access/stable/renew');
  expect(client.getQueryData(['projectDetailById', 1])).toEqual(data);
  screen.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(renew).toHaveBeenCalledTimes(1);
  unsubscribe();
  client.clear();
 });
});
