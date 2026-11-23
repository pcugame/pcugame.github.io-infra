/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { RunEditor } from '../features/term-origins/RunEditor';
import { labApi } from '../lib/api/lab';

vi.mock('../lib/query/visibility', () => ({ useViewerKey: () => (key: unknown) => key }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('retains retrieval on search failure until the user explicitly chooses a model-only run', async () => {
  const create = vi.spyOn(labApi, 'create').mockResolvedValue({ runId: 'run' });
  const datasets = vi.spyOn(labApi, 'datasets').mockResolvedValue([]);
  const onCreated = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}>
    <RunEditor status={{
      enabled: true, model: 'fixture', provider: 'transformers-generate', modelStatus: 'available',
      searchStatus: 'unavailable', toolSupport: 'unsupported', mock: false,
    }} onCreated={onCreated} />
  </QueryClientProvider>);
  fireEvent.change(screen.getByLabelText('닉네임'), { target: { value: '계집' } });
  const button = screen.getByRole<HTMLButtonElement>('button', { name: '검색 후 평가' });
  expect(button.disabled).toBe(true);
  expect(datasets).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('검색 모드'), { target: { value: 'no_search' } });
  fireEvent.click(screen.getByRole('button', { name: '검색 없이 평가' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith('run'));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ nickname: '계집', searchMode: 'no_search' }));
});
