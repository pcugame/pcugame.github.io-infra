/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectPlayPage from '../pages/ProjectPlayPage';
import { queryKeys } from '../lib/query';

vi.mock('../lib/query', async (original) => ({ ...await original<object>(), useViewerKey: () => (key: unknown) => key }));
vi.mock('../lib/graphicsAcceleration', () => ({ detectGraphicsAcceleration: () => 'software' }));
vi.mock('../lib/api', () => ({ publicApi: { getProjectDetail: vi.fn() } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('running React player display snapshot', () => {
  it('keeps display and iframe identity on settings refetch, then adopts settings on explicit restart', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const key = queryKeys.projectDetailById(41);
    const initial = { id: 41, title: 'Fixture', webglUrl: 'https://game.test/index.html', webglDisplayKind: 'fixed', webglDisplayWidth: 800, webglDisplayHeight: 600 };
    qc.setQueryData(key, initial);
    const { container } = render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/projects/41/play']}><Routes><Route path="/projects/:projectId/play" element={<ProjectPlayPage />} /></Routes></MemoryRouter></QueryClientProvider>);
    expect(screen.queryByTitle('Fixture WebGL 플레이어')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: '그래도 실행' }));
    const frame = await screen.findByTitle('Fixture WebGL 플레이어');
    expect(container.querySelector<HTMLElement>('.webgl-viewport__surface')!.style.width).toBe('800px');
    await act(async () => {
      qc.setQueryData(key, { ...initial, webglDisplayKind: 'responsive', webglDisplayWidth: null, webglDisplayHeight: null });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(screen.getByTitle('Fixture WebGL 플레이어')).toBe(frame);
    expect(container.querySelector<HTMLElement>('.webgl-viewport__surface')!.style.width).toBe('800px');
    await act(async () => {
      qc.getQueryCache().find({ queryKey: key })!.setState({ status: 'error', error: new Error('Temporary refetch failure') });
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(screen.getByTitle('Fixture WebGL 플레이어')).toBe(frame);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: '게임 다시 시작' }));
    await waitFor(() => expect(container.querySelector('.webgl-viewport--responsive')).toBeTruthy());
    expect(screen.getByTitle('Fixture WebGL 플레이어')).not.toBe(frame);
    expect(container.querySelector<HTMLElement>('.webgl-viewport__surface')!.style.width).toBe('');
  });
});
