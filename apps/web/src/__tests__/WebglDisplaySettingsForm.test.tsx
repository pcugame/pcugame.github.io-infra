/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AdminProjectDetail, WebglDisplaySettings } from '@pcu/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebglDisplaySettingsForm } from '../features/admin/projects/WebglDisplaySettingsForm';
import { queryKeys } from '../lib/query';

const setWebglDisplay = vi.hoisted(() => vi.fn());
const getWebglDisplay = vi.hoisted(() => vi.fn());
vi.mock('../features/auth', () => ({ useMe: () => ({ user: { id: 1, role: 'USER' }, isPending: false }) }));
vi.mock('../lib/api', () => ({
  userProjectApi: { setWebglDisplay, getWebglDisplay },
  getApiErrorMessage: (error: unknown) => error instanceof Error ? error.message : '저장 실패',
}));

const project = { id: 41, year: 2026, slug: 'my-game', title: 'Original title', canEditWebglDisplay: true, webglDisplayMode: 'manual', webglDisplayWidth: 800, webglDisplayHeight: 600 } as AdminProjectDetail;
function setup(overrides: Partial<AdminProjectDetail> = {}, isPending = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const data = { ...project, ...overrides };
  qc.setQueryData(queryKeys.adminProject(project.id), data);
  const onPendingChange = vi.fn();
  const view = render(<QueryClientProvider client={qc}><WebglDisplaySettingsForm project={data} isPending={isPending} onPendingChange={onPendingChange} /></QueryClientProvider>);
  fireEvent.click(screen.getByText(/WebGL 표시 크기 ·/));
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
    getWebglDisplay.mockReset();
    getWebglDisplay.mockResolvedValue({ analysis: null });
    setWebglDisplay.mockImplementation((_id: number, settings: WebglDisplaySettings) => Promise.resolve(settings));
  });
  it('retains manual input through disclosure toggles and keeps a save error visible when closed', () => {
    const { container } = setup();
    fireEvent.change(width(), { target: { value: '0' } });
    const details = container.querySelector('details')!;
    const summary = details.querySelector('summary')!;
    fireEvent.click(summary);
    expect(details.open).toBe(false);
    expect(width().value).toBe('0');
    expect(setWebglDisplay).not.toHaveBeenCalled();
    fireEvent.click(summary);
    submit();
    fireEvent.click(summary);
    expect(details.open).toBe(false);
    expect(screen.getByRole('alert').closest('details')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('1~8192');
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
    expect(setWebglDisplay).toHaveBeenCalledWith(41, { webglDisplayMode: 'manual', webglDisplayWidth: 1024, webglDisplayHeight: 768 });
    expect(qc.getQueryData(queryKeys.adminProject(41))).toMatchObject({ title: 'Original title', webglDisplayWidth: 1024, webglDisplayHeight: 768 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.projectDetail(2026, 'my-game') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.projectDetailById(41) });
    expect(onPendingChange.mock.calls).toEqual([[true], [false]]);
    expect(save().disabled).toBe(true);
  });
  it('preserves manual dimensions when selecting legacy mode and saves only on submit', async () => {
    setup();
    fireEvent.change(screen.getByLabelText('표시 크기 설정'), { target: { value: 'legacy' } });
    expect(width().value).toBe('800');
    expect(height().value).toBe('600');
    expect(width().disabled).toBe(true);
    expect(setWebglDisplay).not.toHaveBeenCalled();
    fireEvent.click(save());
    await waitFor(() => expect(setWebglDisplay).toHaveBeenCalledWith(41, { webglDisplayMode: 'legacy', webglDisplayWidth: 800, webglDisplayHeight: 600 }));
  });
  it('leaves an unset size blank when selecting custom dimensions', () => {
    setup({ webglDisplayMode: 'auto', webglDisplayWidth: null, webglDisplayHeight: null });
    expect(width().value).toBe('');
    fireEvent.change(screen.getByLabelText('표시 크기 설정'), { target: { value: 'manual' } });
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
    await waitFor(() => expect(setWebglDisplay).toHaveBeenCalledWith(41, { webglDisplayMode: 'manual', webglDisplayWidth: value, webglDisplayHeight: 600 }));
  });
  it('retains unsaved manual values through automatic and legacy mode switches', () => {
    setup();
    fireEvent.change(width(), { target: { value: '1234' } });
    fireEvent.change(screen.getByLabelText('표시 크기 설정'), { target: { value: 'auto' } });
    fireEvent.change(screen.getByLabelText('표시 크기 설정'), { target: { value: 'legacy' } });
    fireEvent.change(screen.getByLabelText('표시 크기 설정'), { target: { value: 'manual' } });
    expect(width().value).toBe('1234');
    expect(height().value).toBe('600');
  });
  it('saves automatic mode without requiring dimensions', async () => {
    setup({ webglDisplayMode: 'legacy', webglDisplayWidth: null, webglDisplayHeight: null });
    fireEvent.change(screen.getByLabelText('표시 크기 설정'), { target: { value: 'auto' } });
    fireEvent.click(save());
    await waitFor(() => expect(setWebglDisplay).toHaveBeenCalledWith(41, { webglDisplayMode: 'auto', webglDisplayWidth: null, webglDisplayHeight: null }));
  });
  it.each([
    [{ version: 1, kind: 'fixed', width: 960, height: 600, reason: null }, '자동 감지: 960 × 600'],
    [{ version: 1, kind: 'responsive', width: null, height: null, reason: null }, '자동 감지: 반응형'],
    [{ version: 1, kind: 'unknown', width: null, height: null, reason: 'conflicting' }, '표시 크기 지정 권장'],
    [null, '아직 분석하지 않은 빌드'],
  ])('shows distinct detection feedback for %j', async (analysis, notice) => {
    getWebglDisplay.mockResolvedValue({ analysis });
    setup();
    await waitFor(() => expect(screen.getByText(new RegExp(notice))).toBeTruthy());
  });
  it('refreshes detection after a replacement deployment while retaining manual values', async () => {
    getWebglDisplay.mockResolvedValue({ analysis: { version: 1, kind: 'fixed', width: 960, height: 600, reason: null } });
    const { rerenderProject } = setup();
    await waitFor(() => expect(screen.getByText(/자동 감지: 960/)).toBeTruthy());
    getWebglDisplay.mockResolvedValue({ analysis: { version: 1, kind: 'responsive', width: null, height: null, reason: null } });
    rerenderProject({ ...project, webglDeployment: { id: 'replacement', url: 'https://game.test', createdAt: '2026-10-01' } });
    await waitFor(() => expect(screen.getByText(/자동 감지: 반응형/)).toBeTruthy());
    expect(width().value).toBe('800');
    expect(height().value).toBe('600');
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
  it('explains a linked member read denial without recommending repeated refreshes', async () => {
    getWebglDisplay.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    setup({ canEditWebglDisplay: false });
    expect(await screen.findByText('분석 결과는 작품 등록자와 관리자만 확인할 수 있습니다.')).toBeTruthy();
    expect(screen.queryByText(/새로고침해 다시 확인/)).toBeNull();
    expect(getWebglDisplay).toHaveBeenCalledTimes(1);
  });
  it('still reads analysis for an owner whose closed-year settings are read-only', async () => {
    getWebglDisplay.mockResolvedValue({ analysis: { version: 1, kind: 'fixed', width: 960, height: 642, reason: null } });
    setup({ canEditWebglDisplay: false, isModificationEnabled: false });
    expect(await screen.findByText(/자동 감지: 960 × 642/)).toBeTruthy();
    expect(save().disabled).toBe(true);
  });

});
