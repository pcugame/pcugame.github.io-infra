/* @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AwardState } from '@pcu/contracts';

const viewer = vi.hoisted(() => ({ role: 'ADMIN' as string | null }));
vi.mock('../features/auth', () => ({ useMe: () => ({ user: viewer.role ? { role: viewer.role } : null }) }));
const api = vi.hoisted(() => ({ read: vi.fn(), edit: vi.fn() }));
vi.mock('../lib/api/awards', () => ({ awardApi: api }));
vi.mock('../lib/api', () => ({ getApiErrorMessage: (error: Error) => error.message }));
vi.mock('../components/DirectImageUploadWidget', () => ({ default: ({ initialFiles, owner }: { initialFiles: File[]; owner: { type: string; id: number } }) =>
  <output aria-label="업로드 대상">{owner.type}:{owner.id}:{initialFiles[0]?.name}</output>,
}));
import { AwardSettings } from '../features/admin/awards/AwardSettings';

const initial: AwardState = {
  version: 3, projects: [],
  items: [{ id: 7, name: '대상', sortOrder: 0, builtinKey: 'medal', assetId: null, projectIds: [] }],
  assets: [{ id: 42, name: 'custom-award.png', imageUrl: '/custom-award.png' }],
};
beforeEach(() => {
  viewer.role = 'ADMIN';
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function renderSettings(state = initial) {
  api.read.mockResolvedValue(state);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AwardSettings exhibitionId={12} /></QueryClientProvider>);
}

it('applies an existing custom icon through the existing versioned award API', async () => {
  const updated: AwardState = { ...initial, version: 4, items: [{ ...initial.items[0], builtinKey: null, assetId: 42, imageUrl: '/custom-award.png' }] };
  api.edit.mockImplementation(async () => { api.read.mockResolvedValue(updated); return updated; });
  renderSettings();
  fireEvent.click(await screen.findByRole('button', { name: '커스텀' }));
  fireEvent.click(screen.getByRole('button', { name: 'custom-award.png 적용' }));
  await waitFor(() => expect(api.edit).toHaveBeenCalledWith(12, 3, { id: 7, name: '대상', builtinKey: null, assetId: 42 }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'custom-award.png 적용' }).getAttribute('aria-pressed')).toBe('true'));
  expect(document.querySelector('.award-card__identity img')?.getAttribute('src')).toBe('/custom-award.png');
});

it('keeps custom file uploads in the existing exhibition upload widget', async () => {
  renderSettings();
  fireEvent.click(await screen.findByRole('button', { name: '커스텀' }));
  fireEvent.change(screen.getByLabelText('대상 이미지 파일'), { target: { files: [new File(['png'], 'my-icon.png', { type: 'image/png' })] } });
  expect(screen.getByLabelText('업로드 대상').textContent).toBe('EXHIBITION:12:my-icon.png');
  expect(api.edit).not.toHaveBeenCalled();
});

it('applies a laurel color directly without uploading an image', async () => {
  const updated: AwardState = { ...initial, version: 4, items: [{ ...initial.items[0], builtinKey: 'laurel-bronze' }] };
  api.edit.mockImplementation(async () => { api.read.mockResolvedValue(updated); return updated; });
  renderSettings();
  fireEvent.click(await screen.findByRole('button', { name: '브론즈' }));
  await waitFor(() => expect(api.edit).toHaveBeenCalledWith(12, 3, { id: 7, name: '대상', builtinKey: 'laurel-bronze', color: '#e0ac7a', assetId: null }));
  await waitFor(() => expect(screen.getByRole('button', { name: '브론즈' }).getAttribute('aria-pressed')).toBe('true'));
  expect(screen.queryByLabelText('업로드 대상')).toBeNull();
  expect(document.querySelector('.award-card__identity svg')?.getAttribute('stroke')).toBe('#e0ac7a');
});

it('shows upload and existing image tiles inline without opening a dialog', async () => {
  renderSettings();
  fireEvent.click(await screen.findByRole('button', { name: '커스텀' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  const group = screen.getByRole('group', { name: '대상 커스텀 아이콘' });
  expect(group.querySelectorAll('.award-card__icon-tile')).toHaveLength(2);
  expect(group.querySelector('img')?.getAttribute('src')).toBe('/custom-award.png');
  const input = screen.getByLabelText('대상 이미지 파일');
  const chooseFile = vi.spyOn(input, 'click');
  fireEvent.click(screen.getByRole('button', { name: '업로드' }));
  expect(chooseFile).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '월계관' }));
  expect(screen.queryByRole('group', { name: '대상 커스텀 아이콘' })).toBeNull();
  expect(screen.getByRole('group', { name: '대상 월계관 색상' }).querySelectorAll('.award-card__icon-tile')).toHaveLength(4);
});

it('edits the name in its original location and preserves recipient drafts during name save', async () => {
  const state: AwardState = { ...initial, projects: [{ id: 21, title: '첫 작품' }, { id: 22, title: '다음 작품' }], items: [{ ...initial.items[0], projectIds: [21] }] };
  api.edit.mockImplementation(async (_id, _version, edit) => {
    const updated = { ...state, version: 4, items: [{ ...state.items[0], name: edit.name }] };
    api.read.mockResolvedValue(updated);
    return updated;
  });
  renderSettings(state);
  await screen.findByRole('button', { name: '수정' });
  expect(screen.queryByRole('textbox', { name: '상 이름' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '수정' }));
  const input = screen.getByRole('textbox', { name: '상 이름' }) as HTMLInputElement;
  expect(input.closest('.award-card__identity')).not.toBeNull();
  expect(screen.getByRole('checkbox', { name: '다음 작품' }).closest('.award-card__recipients')).not.toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: '다음 작품' }));
  fireEvent.change(input, { target: { value: '특별상' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(api.edit).toHaveBeenCalledWith(12, 3, { id: 7, name: '특별상', builtinKey: 'medal', assetId: null }));
  await waitFor(() => expect((screen.getByRole('button', { name: '이름 저장' }) as HTMLButtonElement).disabled).toBe(true));
  expect((screen.getByRole('checkbox', { name: '다음 작품' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '편집 닫기' }));
  expect(screen.queryByRole('textbox', { name: '상 이름' })).toBeNull();
  expect(document.querySelector('.award-card__identity')?.textContent).toContain('특별상');
});

it('retains the name draft on save failure and restores the saved value on Escape or closing', async () => {
  api.edit.mockRejectedValue(new Error('이름 저장 실패'));
  renderSettings();
  fireEvent.click(await screen.findByRole('button', { name: '수정' }));
  const input = screen.getByRole('textbox', { name: '상 이름' }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: '수정 중' } });
  fireEvent.click(screen.getByRole('button', { name: '이름 저장' }));
  expect((await screen.findByRole('alert')).textContent).toContain('이름 저장 실패');
  expect(input.value).toBe('수정 중');
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(input.value).toBe('대상');
  fireEvent.change(input, { target: { value: '   ' } });
  expect((screen.getByRole('button', { name: '이름 저장' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '편집 닫기' }));
  fireEvent.click(screen.getByRole('button', { name: '수정' }));
  expect((screen.getByRole('textbox', { name: '상 이름' }) as HTMLInputElement).value).toBe('대상');
});


it.each([null, 'USER'])('hides award settings and skips protected reads for %s', (role) => {
  viewer.role = role;
  renderSettings();
  expect(screen.queryByRole('region', { name: '상 및 수상작' })).toBeNull();
  expect(api.read).not.toHaveBeenCalled();
});

it.each(['OPERATOR', 'ADMIN'])('allows %s to open award settings', async (role) => {
  viewer.role = role;
  renderSettings();
  expect(await screen.findByRole('heading', { name: '상 및 수상작' })).toBeTruthy();
  expect(api.read).toHaveBeenCalledWith(12);
});

it('searches all recipient members by name and student ID while preserving selections', async () => {
  renderSettings({ ...initial, projects: [
    { id: 21, title: 'Space Game', members: [{ name: '김학생', studentId: '2023001' }, { name: '이참여', studentId: '2023002' }] },
    { id: 22, title: '다른 작품', members: [] },
    { id: 23, title: '이전 API 작품' },
  ] });
  fireEvent.click(await screen.findByRole('button', { name: '수정' }));
  const search = screen.getByRole('searchbox', { name: '작품 검색' });
  fireEvent.click(screen.getByRole('checkbox', { name: /^Space Game/ }));
  for (const query of ['space', '김학생', '이참여', '2023002', '  이참여  2023002  ']) {
    fireEvent.change(search, { target: { value: query } });
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect((screen.getByRole('checkbox', { name: /^Space Game/ }) as HTMLInputElement).checked).toBe(true);
  }
  fireEvent.change(search, { target: { value: '없는 학생' } });
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  expect(screen.getByText('검색 결과가 없습니다.')).toBeTruthy();
  fireEvent.change(search, { target: { value: '   ' } });
  expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  expect((screen.getByRole('checkbox', { name: /^Space Game/ }) as HTMLInputElement).checked).toBe(true);
});

it('previews, validates, saves and resets a custom award color without saving incomplete input', async () => {
  let state: AwardState = { ...initial, items: [{ ...initial.items[0], builtinKey: 'laurel-gold' }] };
  api.edit.mockImplementation(async (_id, _version, edit) => {
    state = { ...state, version: state.version + 1, items: [{ ...state.items[0], ...edit }] };
    api.read.mockResolvedValue(state);
    return state;
  });
  renderSettings(state);
  const input = await screen.findByRole('textbox', { name: '색상 코드' });
  fireEvent.change(input, { target: { value: '#12' } });
  expect((screen.getByRole('button', { name: '색상 저장' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.edit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '#7c3aed' } });
  expect(screen.getByLabelText('색상 미리보기').querySelector('svg')?.getAttribute('stroke')).toBe('#7C3AED');
  expect(screen.getByLabelText('색상 미리보기').style.getPropertyValue('--award-border')).toBe('#7C3AED');
  fireEvent.click(screen.getByRole('button', { name: '색상 저장' }));
  await waitFor(() => expect(api.edit).toHaveBeenCalledWith(12, 3, { id: 7, name: '대상', builtinKey: 'laurel-gold', assetId: null, color: '#7C3AED' }));
  await waitFor(() => expect(document.querySelector('.award-card__identity svg')?.getAttribute('stroke')).toBe('#7C3AED'));
  fireEvent.click(screen.getByRole('button', { name: '기본 색상 복원' }));
  await waitFor(() => expect(api.edit).toHaveBeenLastCalledWith(12, 4, { id: 7, name: '대상', builtinKey: 'laurel-gold', assetId: null, color: null }));
  await waitFor(() => expect(document.querySelector('.award-card__identity svg')?.getAttribute('stroke')).toBe('#f1c46c'));
});

it('keeps a custom color draft when saving fails', async () => {
  api.edit.mockRejectedValue(new Error('색상 저장 실패'));
  renderSettings();
  const input = await screen.findByRole('textbox', { name: '색상 코드' });
  fireEvent.change(input, { target: { value: '#123456' } });
  fireEvent.click(screen.getByRole('button', { name: '색상 저장' }));
  expect((await screen.findByRole('alert')).textContent).toContain('색상 저장 실패');
  expect((input as HTMLInputElement).value).toBe('#123456');
  expect((screen.getByRole('button', { name: '색상 저장' }) as HTMLButtonElement).disabled).toBe(false);
});
