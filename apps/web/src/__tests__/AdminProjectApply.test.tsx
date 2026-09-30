/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminProjectDetail } from '@pcu/contracts';
import AdminProjectEditPage from '../pages/admin/AdminProjectEditPage';
import { adminMemberApi, adminProjectApi } from '../lib/api';
import { queryKeys } from '../lib/query';

const control = vi.hoisted(() => ({ role: 'ADMIN', queueApply: vi.fn(), lock: vi.fn(), queueDirty: false, queueError: null as string | null }));
vi.mock('../features/auth', () => ({ useMe: () => ({ user: { role: control.role } }) }));
vi.mock('../features/admin/projects/AdminProjectAssetManager', () => ({
	AdminProjectUploadProvider: ({ children }: { children: React.ReactNode }) => children,
	AdminProjectAssetManager: () => null,
	AdminProjectPosterUpload: () => null,
	useAdminProjectUploadQueue: () => ({ hasChanges: control.queueDirty, isApplying: false, validationError: control.queueError, applyChanges: control.queueApply, setLocked: control.lock }),
}));
const initial = (): AdminProjectDetail => ({ id: 7, title: '기존 제목', summary: '소개', description: '설명', slug: 'project', year: 2026, platforms: [], isIncomplete: false, video: null, videos: [], status: 'PUBLISHED', sortOrder: 0, canEdit: true, members: [{ id: 10, name: '학생', studentId: '20260001', sortOrder: 0, userId: null }], assets: [] });
let stored: AdminProjectDetail;
let client: QueryClient;
function mount() {
	client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
	return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/admin/projects/7/edit']}><Routes><Route path="/admin/projects/:id/edit" element={<AdminProjectEditPage />} /></Routes></MemoryRouter></QueryClientProvider>);
}
async function ready() { await screen.findByLabelText('제목 *'); }
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
const apply = () => screen.getByRole('button', { name: '적용' }) as HTMLButtonElement;
beforeEach(() => {
	stored = initial(); control.role = 'ADMIN'; control.queueDirty = false; control.queueError = null;
	control.queueApply.mockResolvedValue(undefined);
	vi.spyOn(adminProjectApi, 'getDetail').mockImplementation(async () => stored);
	vi.spyOn(adminProjectApi, 'update').mockImplementation(async (_id, body) => { stored = { ...stored, ...body }; return stored; });
	vi.spyOn(adminMemberApi, 'add').mockResolvedValue({ id: 20 });
	vi.spyOn(adminMemberApi, 'update').mockResolvedValue(undefined);
	vi.spyOn(adminMemberApi, 'remove').mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('global project Apply', () => {
	it('stages visibility and text, applies one PATCH, and resets clean baseline from the response', async () => {
		const { container } = mount(); await ready(); expect(apply().disabled).toBe(true);
		fireEvent.click(screen.getByRole('switch')); change('제목 *', '새 제목');
		expect(adminProjectApi.update).not.toHaveBeenCalled(); expect(apply().disabled).toBe(false);
		const button = apply(); expect(button.form?.id).toBe('project-edit-7'); expect(button.closest('form')).toBeNull();
		expect(container.querySelector('.project-edit-apply')).toContain(button);
		fireEvent.click(button);
		await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledOnce());
		expect(adminProjectApi.update).toHaveBeenCalledWith(7, { title: '새 제목', status: 'ARCHIVED' });
		await waitFor(() => expect(apply().disabled).toBe(true)); expect(screen.getByText('적용되었습니다.')).toBeTruthy();
	});
	it('disables after toggles and text edits are reverted, preserving draft across background refetch', async () => {
		mount(); await ready(); fireEvent.click(screen.getByRole('switch')); fireEvent.click(screen.getByRole('switch'));
		expect(apply().disabled).toBe(true); change('제목 *', '초안');
		stored = { ...stored, title: '서버 갱신', description: '외부 설명' };
		await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.adminProject(7) }); });
		expect((screen.getByLabelText('제목 *') as HTMLInputElement).value).toBe('초안');
		change('제목 *', '기존 제목'); await waitFor(() => expect(apply().disabled).toBe(true));
		change('제목 *', '최종 제목'); fireEvent.click(apply());
		await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledWith(7, { title: '최종 제목' }));
		await waitFor(() => expect(apply().disabled).toBe(true));
		expect(stored.description).toBe('외부 설명');
	});
	it('retains failed draft and retries without repeating successful member additions', async () => {
		vi.mocked(adminProjectApi.update).mockRejectedValueOnce(new Error('저장 실패'));
		mount(); await ready(); change('제목 *', '초안'); fireEvent.click(screen.getByRole('button', { name: '참여 학생 추가' }));
		change('참여 학생 2 이름', '새 학생'); change('참여 학생 2 학번', '20260002');
		expect(adminMemberApi.add).not.toHaveBeenCalled(); fireEvent.click(apply());
		await screen.findByRole('alert'); expect(adminMemberApi.add).toHaveBeenCalledOnce();
		expect((screen.getByLabelText('제목 *') as HTMLInputElement).value).toBe('초안');
		await waitFor(() => expect(apply().disabled).toBe(false)); fireEvent.click(apply());
		await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(apply().disabled).toBe(true)); expect(adminMemberApi.add).toHaveBeenCalledOnce();
	});
	it('validates every metadata field and members before any operation', async () => {
		mount(); await ready(); change('제목 *', ''); change('한줄 소개', 'x'.repeat(301)); change('상세 설명', 'x'.repeat(5001)); change('오프셋(작을수록 상단에 표시)', '-1');
		fireEvent.click(apply()); await screen.findByText('제목을 입력하세요');
		expect(screen.getByLabelText('한줄 소개').parentElement?.querySelector('.field-error')).toBeTruthy();
		expect(screen.getByLabelText('상세 설명').parentElement?.querySelector('.field-error')).toBeTruthy();
		expect(screen.getByLabelText('오프셋(작을수록 상단에 표시)').parentElement?.querySelector('.field-error')).toBeTruthy();
		expect(control.queueApply).not.toHaveBeenCalled(); expect(adminProjectApi.update).not.toHaveBeenCalled();
		change('제목 *', '제목'); change('한줄 소개', ''); change('상세 설명', ''); change('오프셋(작을수록 상단에 표시)', '0'); change('참여 학생 1 이름', '');
		fireEvent.click(apply()); await screen.findByText(/참여 학생 1: 이름/);
		expect(adminMemberApi.update).not.toHaveBeenCalled(); expect(control.queueApply).not.toHaveBeenCalled();
	});
	it.each(['USER', 'DRAFT'])('keeps visibility protected for %s and omits unchanged status', async (mode) => {
		if (mode === 'USER') control.role = 'USER'; else stored.status = 'DRAFT';
		mount(); await ready(); expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
		change('제목 *', '제목'); fireEvent.click(apply()); await waitFor(() => expect(adminProjectApi.update).toHaveBeenCalledOnce());
		expect(vi.mocked(adminProjectApi.update).mock.calls[0][1]).not.toHaveProperty('status');
	});
	it('locks metadata, members, and apply while pending and runs publication after domains', async () => {
		let finish!: () => void; control.queueApply.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
		mount(); await ready(); fireEvent.click(screen.getByRole('switch')); fireEvent.click(apply());
		await screen.findByRole('button', { name: '적용 중…' });
		expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByLabelText('제목 *').closest('fieldset')?.disabled).toBe(true);
		expect(screen.getByLabelText('참여 학생 1 이름').closest('fieldset')?.disabled).toBe(true);
		expect(control.lock).toHaveBeenCalledWith(true); expect(adminProjectApi.update).not.toHaveBeenCalled();
		await act(async () => finish()); await waitFor(() => expect(apply().disabled).toBe(true)); expect(control.lock).toHaveBeenLastCalledWith(false);
	});
	it('blocks queued file validation before member or metadata writes', async () => {
		control.queueError = '파일 확인'; mount(); await ready(); change('제목 *', '제목'); fireEvent.click(apply());
		await screen.findByRole('alert'); expect(control.queueApply).not.toHaveBeenCalled(); expect(adminProjectApi.update).not.toHaveBeenCalled();
	});
});
