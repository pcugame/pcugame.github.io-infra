/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { RunEditor } from '../features/nickname-evaluation/RunEditor';
import { labApi } from '../lib/api/lab';

vi.mock('../lib/query/visibility', () => ({ useViewerKey: () => (key: unknown) => key }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('retains retrieval on search failure until the user explicitly chooses a model-only run', async () => {
  const create = vi.spyOn(labApi, 'create').mockResolvedValue({ runId: 'run' });
  vi.spyOn(labApi, 'datasets').mockResolvedValue([{
    id: 'dataset', name: 'fixture', hash: 'a'.repeat(64), count: 1, version: '3', schemaVersion: '3', createdAt: '2026-11-25T00:00:00Z',
  }]);
  vi.spyOn(labApi, 'cases').mockResolvedValue({ items: [], total: 1 });
  const onCreated = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}>
    <RunEditor status={{
      enabled: true, model: 'fixture', provider: 'transformers-generate', modelStatus: 'available',
      searchStatus: 'unavailable', toolSupport: 'unsupported', mock: false,
    }} onCreated={onCreated} />
  </QueryClientProvider>);
  const button = screen.getByRole<HTMLButtonElement>('button', { name: '1개 평가 실행' });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('검색 모드'), { target: { value: 'backend_retrieval' } });
  expect(button.disabled).toBe(true);
  expect(create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('검색 모드'), { target: { value: 'no_search' } });
  fireEvent.click(button);
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith('run'));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ datasetId: 'dataset', searchMode: 'no_search' }));
});
