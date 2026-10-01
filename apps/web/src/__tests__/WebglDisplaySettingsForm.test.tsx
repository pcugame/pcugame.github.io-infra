/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AdminProjectDetail, WebglDisplaySettings } from '@pcu/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebglDisplaySettingsForm } from '../features/admin/projects/WebglDisplaySettingsForm';
import { queryKeys } from '../lib/query';

const setWebglDisplay = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', () => ({
  userProjectApi: { setWebglDisplay },
  getApiErrorMessage: (error: unknown) => error instanceof Error ? error.message : '저장 실패',
}));

const project = { id: 41, year: 2026, slug: 'my-game', title: 'Original title', canEditWebglDisplay: true, webglDisplayWidth: 800, webglDisplayHeight: 600 } as AdminProjectDetail;
function setup(overrides: Partial<AdminProjectDetail> = {}, isPending = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const data = { ...project, ...overrides };
  qc.setQueryData(queryKeys.adminProject(project.id), data);
  const onPendingChange = vi.fn();
  const view = render(<QueryClientProvider client={qc}><WebglDisplaySettingsForm project={data} isPending={isPending} onPendingChange={onPendingChange} /></QueryClientProvider>);
  return { qc, onPendingChange, ...view, rerenderProject: (next: AdminProjectDetail) => view.rerender(<QueryClientProvider client={qc}><WebglDisplaySettingsForm project={next} isPending={isPending} onPendingChange={onPendingChange} /></QueryClientProvider>) };
}
const width = () => screen.getByLabelText('가로 (CSS px)') as HTMLInputElement;
const height = () => screen.getByLabelText('세로 (CSS px)') as HTMLInputElement;
const save = () => screen.getByRole('button', { name: '표시 크기 저장' }) as HTMLButtonElement;
const submit = () => fireEvent.submit(screen.getByRole('form', { name: 'WebGL 표시 크기 설정' }));

describe('WebglDisplaySettingsForm', () => {
  afterEach(cleanup);
  beforeEach(() => {
    setWebglDisplay.mockReset();
    setWebglDisplay.mockImplementation((_id: number, settings: WebglDisplaySettings) => Promise.resolve(settings));
  });
  it('hydrates saved dimensions and saves only display settings, preserving metadata cache', async () => {
    const { qc, onPendingChange } = setup();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    expect(width().value).toBe('800');
    expect(height().value).toBe('600');
    fireEvent.change(width(), { target: { value: '1024' } });
    fireEvent.change(height(), { target: { value: '768' } });
    fireEvent.click(save());
    await waitFor(() => expect(screen.getByText('표시 크기가 저장되었습니다.')).toBeTruthy());
    expect(setWebglDisplay).toHaveBeenCalledWith(41, { webglDisplayWidth: 1024, webglDisplayHeight: 768 });
    expect(qc.getQueryData(queryKeys.adminProject(41))).toMatchObject({ title: 'Original title', webglDisplayWidth: 1024, webglDisplayHeight: 768 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.projectDetail(2026, 'my-game') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.projectDetailById(41) });
    expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
    expect(save().disabled).toBe(true);
  });
  it('clears both values explicitly and persists the reset only after save', async () => {
    setup();
    fireEvent.change(screen.getByLabelText('표시 크기 설정'), { target: { value: 'default' } });
    expect(width().value).toBe('');
    expect(height().value).toBe('');
    expect(width().disabled).toBe(true);
    expect(setWebglDisplay).not.toHaveBeenCalled();
    fireEvent.click(save());
    await waitFor(() => expect(setWebglDisplay).toHaveBeenCalledWith(41, { webglDisplayWidth: null, webglDisplayHeight: null }));
  });
  it('leaves an unset size blank when selecting custom dimensions', () => {
    setup({ webglDisplayWidth: null, webglDisplayHeight: null });
    expect(width().value).toBe('');
    fireEvent.change(screen.getByLabelText('표시 크기 설정'), { target: { value: 'custom' } });
    expect(width().value).toBe('');
    expect(height().value).toBe('');
    submit();
    expect(screen.getByRole('alert').textContent).toContain('가로와 세로를 모두');
    expect(setWebglDisplay).not.toHaveBeenCalled();
  });
  it.each(['', '0', '-1', '1.5', '8193', '1e3', 'abc'])('rejects invalid or unpaired dimensions: %s', (value) => {
    setup();
    fireEvent.change(width(), { target: { value } });
    submit();
    expect(screen.getByRole('alert').textContent).toContain('1~8192');
    expect(setWebglDisplay).not.toHaveBeenCalled();
  });
  it.each([1, 8192])('accepts the inclusive dimension boundary %s', async (value) => {
    setup();
    fireEvent.change(width(), { target: { value: String(value) } });
    fireEvent.click(save());
    await waitFor(() => expect(setWebglDisplay).toHaveBeenCalledWith(41, { webglDisplayWidth: value, webglDisplayHeight: 600 }));
  });
  it('locks while saving, rejects duplicate submit, and preserves draft on failure for retry', async () => {
    let reject!: (error: Error) => void;
    setWebglDisplay.mockReturnValue(new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const { onPendingChange } = setup();
    fireEvent.change(width(), { target: { value: '1024' } });
    submit();
    expect(screen.getByRole('button', { name: '표시 크기 저장 중…' }).closest('fieldset')?.disabled).toBe(true);
    submit();
    expect(setWebglDisplay).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('권한이 변경되었습니다.')));
    expect(screen.getByRole('alert').textContent).toBe('권한이 변경되었습니다.');
    expect(width().value).toBe('1024');
    expect(save().disabled).toBe(false);
    expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
  });
  it.each([{ canEditWebglDisplay: false }, { canEditWebglDisplay: undefined }])('requires explicit permission: %j', (flags) => {
    setup(flags);
    expect(save().closest('fieldset')?.disabled).toBe(true);
    submit();
    expect(setWebglDisplay).not.toHaveBeenCalled();
  });
  it('disables the separate save during general Apply', () => {
    setup({}, true);
    expect(save().closest('fieldset')?.disabled).toBe(true);
    submit();
    expect(setWebglDisplay).not.toHaveBeenCalled();
  });
  it('preserves local draft and validation feedback across a detail refetch', () => {
    const { rerenderProject } = setup();
    fireEvent.change(width(), { target: { value: '0' } });
    submit();
    rerenderProject({ ...project, title: 'Refetched title', webglDisplayWidth: 1200, webglDisplayHeight: 900 });
    expect(width().value).toBe('0');
    expect(height().value).toBe('600');
    expect(screen.getByRole('alert').textContent).toContain('1~8192');
  });
});
