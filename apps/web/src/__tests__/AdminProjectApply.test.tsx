/* @vitest-environment jsdom */
import './helpers/dialog';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadEntry } from '../lib/upload/project-files';
import type { AdminProjectDetail } from '@pcu/contracts';
import AdminProjectEditPage from '../pages/admin/AdminProjectEditPage';
import { adminMemberApi, adminProjectApi } from '../lib/api';
import { queryKeys } from '../lib/query';

const control = vi.hoisted(() => ({ role: 'ADMIN', visibilityEnabled: true, queueApply: vi.fn(), lock: vi.fn(), queueDirty: false, queueError: null as string | null, entries: [] as UploadEntry[], removals: [] as number[] }));
vi.mock('../features/auth', () => ({ useMe: () => ({ user: { role: control.role } }) }));
vi.mock('../features/admin/projects/AdminProjectAssetManager', () => ({
	AdminProjectUploadProvider: ({ children }: { children: React.ReactNode }) => children,
	AdminProjectAssetManager: () => null,
	AdminProjectUploadProgress: () => null,
	AdminProjectPosterUpload: () => null,
	useAdminProjectUploadQueue: () => ({ entries: control.entries, removals: control.removals, hasChanges: control.queueDirty, isApplying: false, validationError: control.queueError, applyChanges: control.queueApply, setLocked: control.lock }),
}));
vi.mock('../lib/env', () => ({ env: { get VISIBILITY_CONTROLS_ENABLED() { return control.visibilityEnabled; } } }));
const initial = (): AdminProjectDetail => ({ visibility: 'PUBLIC', exhibitionVisibility: 'PUBLIC', canChangeVisibility: true, id: 7, title: '기존 제목', summary: '소개', description: '설명', slug: 'project', year: 2026, platforms: [], isIncomplete: false, video: null, videos: [], status: 'PUBLISHED', sortOrder: 0, canEdit: true, members: [{ id: 10, name: '학생', studentId: '20260001', sortOrder: 0, userId: null }], assets: [] });
let stored: AdminProjectDetail;
let client: QueryClient;
function mount() {
	client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
	return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/admin/projects/7/edit']}><Routes><Route path="/admin/projects/:id/edit" element={<AdminProjectEditPage />} /></Routes></MemoryRouter></QueryClientProvider>);
}
async function ready() { await screen.findByLabelText('작품명 *'); }
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function goTo(step: number) { fireEvent.click(screen.getByRole('navigation', { name: '작품 작성 단계' }).querySelectorAll('button')[step]!); }
function chooseVisibility(label: string) {
 goTo(0);
 fireEvent.change(screen.getByRole('combobox', { name: '공개 범위' }), { target: { value: (screen.getByRole('option', { name: label }) as HTMLOptionElement).value } });
}
const apply = () => { const retry = screen.queryByRole('button', { name: '다시 적용' }); if (retry) return retry as HTMLButtonElement; goTo(3); return screen.getByRole('button', { name: '적용' }) as HTMLButtonElement; };
beforeEach(() => {
	stored = initial(); control.entries = []; control.removals = []; control.visibilityEnabled = true; control.role = 'ADMIN'; control.queueDirty = false; control.queueError = null;
	control.queueApply.mockResolvedValue(undefined);
	vi.spyOn(adminProjectApi, 'getDetail').mockImplementation(async () => stored);
	vi.spyOn(adminProjectApi, 'update').mockImplementation(async (_id, body) => { stored = { ...stored, ...body }; return stored; });
	vi.spyOn(adminMemberApi, 'add').mockResolvedValue({ id: 20 });
	vi.spyOn(adminMemberApi, 'update').mockResolvedValue(undefined);
	vi.spyOn(adminMemberApi, 'remove').mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('global project Apply', () => {
	it('keeps Apply visible across all steps and disables invalid input', async () => {
		mount(); await ready();
		const button = () => screen.getByRole('button', { name: '적용' }) as HTMLButtonElement;
		expect(button().disabled).toBe(true);
		change('작품명 *', '새 제목');
		for (const step of [0, 1, 2, 3]) { goTo(step); expect(button().disabled).toBe(false); }
		goTo(2);
		const display = screen.getByRole('form', { name: 'WebGL 표시 크기 설정' });
		expect(display.closest('.submission-studio__sheet')).toBeNull();
		expect(display.classList.contains('webgl-display-settings--horizontal')).toBe(true);
		expect(display.querySelector('details')?.open).toBe(true);
		goTo(0); change('작품명 *', ''); expect(button().disabled).toBe(true);
	});

 it('previews edited text and saved media, stages poster removal and restores it without saving', async () => {
  const poster = { original: { url: 'https://images.test/saved.webp', width: 480, height: 672 }, renditions: [] };
  stored = { ...stored, poster, posterAssetId: 30, assets: [
   { id: 30, kind: 'POSTER', image: poster, originalName: 'poster.webp', size: 100 },
   { id: 31, kind: 'GAME', url: '/game.zip', originalName: 'saved-game.zip', size: 200 },
  ] };
  mount(); await ready();
  const card = within(screen.getByRole('article', { name: '전시 카드 미리보기' }));
  expect(card.getByAltText('기존 제목 포스터').getAttribute('src')).toBe(poster.original.url);
  change('작품명 *', '수정 미리보기');
  expect(card.getByRole('heading', { name: '수정 미리보기' })).toBeTruthy();
  goTo(3);
  expect(screen.getByText(/파일명: saved-game.zip/)).toBeTruthy();
  control.removals = [30]; goTo(0);
  expect(card.queryByRole('img')).toBeNull();
  goTo(3); expect(document.querySelector('.project-preview-inline img')).toBeNull();
  control.removals = []; goTo(0);
  expect(card.getByAltText('수정 미리보기 포스터')).toBeTruthy();
  expect(adminProjectApi.update).not.toHaveBeenCalled();
 });

 it('keeps selected replacement media and member edits through navigation and uses document order', async () => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:replacement'), revokeObjectURL: vi.fn() });
  control.entries = [{ id: 1, kind: 'POSTER', zone: 'poster', status: 'pending', file: new File(['image'], 'replacement.png', { type: 'image/png' }) }];
  mount(); await ready();
  goTo(1); change('참여 학생 1 이름', '변경 학생');
  const platform = screen.getByLabelText('PC');
  const member = screen.getByLabelText('참여 학생 1 이름');
  const link = screen.getByLabelText('외부 링크 1 URL');
  expect(platform.compareDocumentPosition(member) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(member.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  goTo(3); expect(screen.getByText('변경 학생')).toBeTruthy();
  expect(document.querySelector('.project-preview-inline img')?.getAttribute('src')).toBe('blob:replacement');
  goTo(0); goTo(1);
  expect((screen.getByLabelText('참여 학생 1 이름') as HTMLInputElement).value).toBe('변경 학생');
  expect(adminMemberApi.update).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
 });

 it.each([true, false])('uses visibility rather than archive controls when enabled: %s', async enabled => {
  control.visibilityEnabled = enabled;
  mount(); await ready();
  expect(screen.queryByRole('switch', { name: '작품 보관' })).toBeNull();
  expect(screen.getByLabelText('저장된 공개 범위').textContent).toContain('현재 조회 대상: 전체 공개');
  if (enabled) {
   chooseVisibility('운영자·관리자');
   fireEvent.click(apply());
   await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledWith(7, { visibility: 'STAFF' }));
   expect(stored.status).toBe('PUBLISHED');
  } else {
   expect(screen.queryByRole('combobox', { name: '공개 범위' })).toBeNull();
   expect(screen.getByText(/공개 범위 변경 기능이 비활성화/)).toBeTruthy();
   expect(apply().disabled).toBe(true);
  }
 });
 it('does not claim an untouched audience will be saved after a background restriction', async () => {
  mount(); await ready();
  stored = { ...stored, visibility: 'STAFF' };
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.adminProject(7) }); });
  await waitFor(() => expect(screen.getByLabelText('저장된 공개 범위').textContent).toContain('현재 조회 대상: 운영자·관리자'));
  expect(screen.queryByText(/선택한 공개 범위는 아직 저장되지 않았습니다/)).toBeNull();
  expect(apply().disabled).toBe(true);
  change('작품명 *', '제목만 변경'); fireEvent.click(apply());
  await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledWith(7, { title: '제목만 변경' }));
  await screen.findByText('적용되었습니다.');
  expect(stored.visibility).toBe('STAFF');
 });
 it('keeps saved access visible after a failed visibility save and refreshes it after retry and remount', async () => {
  stored.exhibitionVisibility = 'AUTHENTICATED';
  vi.mocked(adminProjectApi.update).mockRejectedValueOnce(new Error('저장 실패'));
  const view = mount(); await ready();
  expect(screen.getByLabelText('저장된 공개 범위').textContent).toContain('현재 조회 대상: 로그인 사용자');
  chooseVisibility('운영자·관리자'); fireEvent.click(apply());
  await screen.findByRole('alert');
  expect(screen.getByText(/선택한 공개 범위는 아직 저장되지 않았습니다/)).toBeTruthy();
  expect(screen.getByLabelText('저장된 공개 범위').textContent).toContain('현재 조회 대상: 로그인 사용자');
  fireEvent.click(apply());
  await screen.findByText('적용되었습니다.');
  expect(adminProjectApi.update).toHaveBeenLastCalledWith(7, { visibility: 'STAFF' });
  expect(screen.getByLabelText('저장된 공개 범위').textContent).toContain('현재 조회 대상: 운영자·관리자');
  expect(screen.queryByText(/선택한 공개 범위는 아직 저장되지 않았습니다/)).toBeNull();
  expect(stored.status).toBe('PUBLISHED');
  view.unmount(); client.clear(); mount(); await ready();
  expect(screen.getByLabelText('저장된 공개 범위').textContent).toContain('현재 조회 대상: 운영자·관리자');
 });
 it('edits existing links and explicitly clears all links without reviving legacy GitHub', async () => {
  stored = { ...stored, githubUrl: 'https://github.com/legacy', externalLinks: [{ label: '게임', url: 'https://example.com/old' }] };
  mount(); await ready();
  change('외부 링크 1 URL', 'https://example.com/new'); fireEvent.click(apply());
  await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledWith(7, { externalLinks: [{ label: '게임', url: 'https://example.com/new' }] }));
  await waitFor(() => expect(apply().disabled).toBe(true));
  await screen.findByText('적용되었습니다.');
  goTo(1); fireEvent.click(screen.getByRole('button', { name: '외부 링크 1 삭제' }));
  await waitFor(() => expect(apply().disabled).toBe(false)); fireEvent.click(apply());
  await waitFor(() => expect(adminProjectApi.update).toHaveBeenLastCalledWith(7, { externalLinks: [] }));
  await waitFor(() => expect(apply().disabled).toBe(true));
  expect((screen.getByLabelText('외부 링크 1 URL') as HTMLInputElement).value).toBe('');
 });

 it('initializes, changes, and explicitly clears execution requirements', async () => {
  stored = { ...stored, platforms: ['PC'], hardwareRequirements: 'VR 헤드셋' };
  mount(); await ready();
  expect((screen.getByLabelText('PC') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('필수 하드웨어') as HTMLTextAreaElement).value).toBe('VR 헤드셋');
  fireEvent.click(screen.getByLabelText('PC')); fireEvent.click(screen.getByLabelText('PC'));
  await waitFor(() => expect(apply().disabled).toBe(true));
  fireEvent.click(screen.getByLabelText('웹')); change('필수 하드웨어', '컨트롤러'); fireEvent.click(apply());
  await waitFor(() => expect(adminProjectApi.update).toHaveBeenLastCalledWith(7, { platforms: ['PC', 'WEB'], hardwareRequirements: '컨트롤러' }));
  await screen.findByText('적용되었습니다.');
  await waitFor(() => expect(apply().disabled).toBe(true));
  fireEvent.click(screen.getByLabelText('PC')); fireEvent.click(screen.getByLabelText('웹')); change('필수 하드웨어', '');
  await waitFor(() => expect(apply().disabled).toBe(false)); fireEvent.click(apply());
  await waitFor(() => expect(adminProjectApi.update).toHaveBeenLastCalledWith(7, { platforms: [], hardwareRequirements: '' }));
 });
 it('normalizes whitespace hardware without sending an empty metadata patch', async () => {
  mount(); await ready(); change('필수 하드웨어', '   '); fireEvent.click(apply());
  await screen.findByText('적용되었습니다.');
  expect(adminProjectApi.update).not.toHaveBeenCalled();
  expect((screen.getByLabelText('필수 하드웨어') as HTMLTextAreaElement).value).toBe('');
  expect(apply().disabled).toBe(true);
 });
 it('preserves untouched execution requirements refreshed in the background', async () => {
  stored = { ...stored, platforms: ['WEB', 'PC'] };
  mount(); await ready();
  fireEvent.click(screen.getByLabelText('PC')); fireEvent.click(screen.getByLabelText('PC'));
  await waitFor(() => expect(apply().disabled).toBe(true));
  change('작품명 *', '제목만 변경');
  stored = { ...stored, platforms: ['WEB'], hardwareRequirements: '새 하드웨어' };
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.adminProject(7) }); });
  fireEvent.click(apply());
  await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledWith(7, { title: '제목만 변경' }));
  expect(stored.platforms).toEqual(['WEB']); expect(stored.hardwareRequirements).toBe('새 하드웨어');
 });
 it('stages visibility until Apply, resets its baseline, and treats a reverted selection as clean', async () => {
  mount(); await ready();
  chooseVisibility('운영자·관리자');
  expect(adminProjectApi.update).not.toHaveBeenCalled();
  expect(apply().disabled).toBe(false);
  chooseVisibility('전체 공개');
  await waitFor(() => expect(apply().disabled).toBe(true));
  chooseVisibility('로그인 사용자');
  fireEvent.click(apply());
  await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledWith(7, { visibility: 'AUTHENTICATED' }));
  await waitFor(() => expect(apply().disabled).toBe(true));
  expect((screen.getByLabelText('공개 범위') as HTMLSelectElement).selectedOptions[0].textContent).toContain('로그인 사용자');
  expect(screen.getByText('적용되었습니다.')).toBeTruthy();
 });
 it('preserves visibility draft across background reads and drops it if capability is revoked before Apply', async () => {
  mount(); await ready();
  chooseVisibility('운영자·관리자');
  stored = { ...stored, description: '외부 설명' };
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.adminProject(7) }); });
  expect((screen.getByLabelText('공개 범위') as HTMLSelectElement).selectedOptions[0].textContent).toContain('운영자·관리자');
  stored = { ...stored, canChangeVisibility: false };
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.adminProject(7) }); });
  expect((screen.getByLabelText('공개 범위') as HTMLSelectElement).disabled).toBe(true);
  expect(screen.queryByText(/선택한 공개 범위는 아직 저장되지 않았습니다/)).toBeNull();
  change('작품명 *', '제목만 변경'); fireEvent.click(apply());
  await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledWith(7, { title: '제목만 변경' }));
  expect(stored.visibility).toBe('PUBLIC');
  expect(stored.description).toBe('외부 설명');
 });
 it('shows a disabled visibility field and blocks Apply in a locked contributor exhibition', async () => {
  control.role = 'USER'; stored = { ...stored, canChangeVisibility: false, canEdit: false };
  mount(); await ready();
  expect((screen.getByLabelText('공개 범위') as HTMLSelectElement).disabled).toBe(true);
  expect(apply().disabled).toBe(true);
  expect(screen.getByLabelText('필수 하드웨어').closest('fieldset')?.disabled).toBe(true);
  expect(screen.getByLabelText('PC').closest('fieldset')?.disabled).toBe(true);
  fireEvent.click(apply()); expect(adminProjectApi.update).not.toHaveBeenCalled();
 });
	it('stages visibility and text, applies one PATCH, and resets clean baseline from the response', async () => {
		const { container } = mount(); await ready(); expect(apply().disabled).toBe(true);
		chooseVisibility('운영자·관리자'); change('작품명 *', '새 제목');
		expect(adminProjectApi.update).not.toHaveBeenCalled(); expect(apply().disabled).toBe(false);
		const button = apply(); expect(button.form?.id).toBe('project-edit-7'); expect(button.closest('form')).toBeNull();
		expect(container.querySelector('.submission-studio__actions')).toContain(button);
		fireEvent.click(button);
		await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledOnce());
		expect(adminProjectApi.update).toHaveBeenCalledWith(7, { title: '새 제목', visibility: 'STAFF' });
		await waitFor(() => expect(apply().disabled).toBe(true)); expect(screen.getByText('적용되었습니다.')).toBeTruthy();
	});
	it('disables after toggles and text edits are reverted, preserving draft across background refetch', async () => {
		mount(); await ready(); chooseVisibility('운영자·관리자'); chooseVisibility('전체 공개');
		expect(apply().disabled).toBe(true); change('작품명 *', '초안');
		stored = { ...stored, title: '서버 갱신', description: '외부 설명' };
		await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.adminProject(7) }); });
		expect((screen.getByLabelText('작품명 *') as HTMLInputElement).value).toBe('초안');
		change('작품명 *', '기존 제목'); await waitFor(() => expect(apply().disabled).toBe(true));
		change('작품명 *', '최종 제목'); fireEvent.click(apply());
		await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledWith(7, { title: '최종 제목' }));
		await waitFor(() => expect(apply().disabled).toBe(true));
		expect(stored.description).toBe('외부 설명');
	});
	it('retains failed draft and retries without repeating successful member additions', async () => {
		vi.mocked(adminProjectApi.update).mockRejectedValueOnce(new Error('저장 실패'));
		mount(); await ready(); change('작품명 *', '초안'); goTo(1); fireEvent.click(screen.getByRole('button', { name: '＋ 학생 추가' }));
		change('참여 학생 2 이름', '새 학생'); change('참여 학생 2 학번', '20260002');
		expect(adminMemberApi.add).not.toHaveBeenCalled(); fireEvent.click(apply());
		await screen.findByRole('alert'); expect(adminMemberApi.add).toHaveBeenCalledOnce();
		expect((screen.getByLabelText('작품명 *') as HTMLInputElement).value).toBe('초안');
		await waitFor(() => expect(apply().disabled).toBe(false)); fireEvent.click(apply());
		await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(apply().disabled).toBe(true)); expect(adminMemberApi.add).toHaveBeenCalledOnce();
	});
	it('validates every metadata field and members before any operation', async () => {
		mount(); await ready(); change('작품명 *', ''); change('한 줄 소개 선택', 'x'.repeat(301)); change('상세 설명 선택', 'x'.repeat(5001)); change('오프셋(작을수록 상단에 표시)', '-1');
		expect(apply().disabled).toBe(true); fireEvent.submit(document.getElementById('project-edit-7')!); await screen.findByText('제목을 입력하세요');
		expect(screen.getByLabelText('한 줄 소개 선택').parentElement?.querySelector('.field-error')).toBeTruthy();
		expect(screen.getByLabelText('상세 설명 선택').parentElement?.querySelector('.field-error')).toBeTruthy();
		expect(screen.getByLabelText('오프셋(작을수록 상단에 표시)').parentElement?.querySelector('.field-error')).toBeTruthy();
		expect(control.queueApply).not.toHaveBeenCalled(); expect(adminProjectApi.update).not.toHaveBeenCalled();
		change('작품명 *', '제목'); change('한 줄 소개 선택', ''); change('상세 설명 선택', ''); change('오프셋(작을수록 상단에 표시)', '0'); change('참여 학생 1 이름', '');
		expect(apply().disabled).toBe(true); fireEvent.submit(document.getElementById('project-edit-7')!); await screen.findByText(/참여 학생 1: 이름/);
		expect(adminMemberApi.update).not.toHaveBeenCalled(); expect(control.queueApply).not.toHaveBeenCalled();
	});
	it.each(['USER', 'DRAFT'])('omits publication status from editing for %s and omits unchanged status', async (mode) => {
		if (mode === 'USER') control.role = 'USER'; else stored.status = 'DRAFT';
		mount(); await ready(); expect(screen.queryByRole('switch', { name: '작품 보관' })).toBeNull();
		change('작품명 *', '제목'); fireEvent.click(apply()); await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledOnce());
		expect(vi.mocked(adminProjectApi.update).mock.calls[0][1]).not.toHaveProperty('status');
	});
	it('locks metadata, members, and apply while pending and runs publication after domains', async () => {
		let finish!: () => void; control.queueApply.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
		mount(); await ready(); chooseVisibility('운영자·관리자'); fireEvent.click(apply());
		await screen.findByRole('dialog', { name: '변경사항을 적용하고 있어요.' });
        expect(screen.queryByRole('button', { name: '적용 중…' })).toBeNull();
		expect(screen.queryByRole('switch', { name: '작품 보관' })).toBeNull();
		expect(screen.getByLabelText('작품명 *').closest('fieldset')?.disabled).toBe(true);
		expect(screen.getByLabelText('필수 하드웨어').closest('fieldset')?.disabled).toBe(true);
		expect(screen.getByLabelText('참여 학생 1 이름').closest('fieldset')?.disabled).toBe(true);
		expect(control.lock).toHaveBeenCalledWith(true); expect(adminProjectApi.update).not.toHaveBeenCalled();
		await act(async () => finish()); await waitFor(() => expect(apply().disabled).toBe(true)); expect(control.lock).toHaveBeenLastCalledWith(false);
	});
	it('blocks queued file validation before member or metadata writes', async () => {
		control.queueError = '파일 확인'; mount(); await ready(); change('작품명 *', '제목'); expect(apply().disabled).toBe(true); fireEvent.submit(document.getElementById('project-edit-7')!);
		await screen.findAllByRole('alert'); expect(control.queueApply).not.toHaveBeenCalled(); expect(adminProjectApi.update).not.toHaveBeenCalled();
	});
});
