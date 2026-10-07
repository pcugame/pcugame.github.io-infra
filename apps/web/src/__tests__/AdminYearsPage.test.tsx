/* @vitest-environment jsdom */
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminExhibitionItem } from '@pcu/contracts';
import AdminYearsPage from '../pages/admin/AdminYearsPage';
import { adminExhibitionApi } from '../lib/api';
const controls = vi.hoisted(() => ({
	role: 'ADMIN',
	visibility: true,
	mounts: vi.fn(),
	unmounts: vi.fn(),
}));
vi.mock('../features/auth', () => ({
	useMe: () => ({ user: { role: controls.role } }),
}));
vi.mock('../lib/env', () => ({
	env: {
		get VISIBILITY_CONTROLS_ENABLED() {
			return controls.visibility;
		},
	},
}));
vi.mock('../components/DirectImageUploadWidget', async () => {
	const { useEffect } = await import('react');
	return {
		default: function Upload({ onComplete }: { onComplete: () => void }) {
			useEffect(() => {
				controls.mounts();
				return controls.unmounts;
			}, []);
			return (
				<>
					<input type="file" aria-label="포스터 파일" />
					<button onClick={onComplete}>업로드 완료 재현</button>
				</>
			);
		},
	};
});
let stored: AdminExhibitionItem[];
let client: QueryClient;
function mount() {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AdminYearsPage />
		</QueryClientProvider>,
	);
}
const open = async (index = 0) =>
	fireEvent.click(
		(await screen.findAllByRole('button', { name: '설정' }))[index]!,
	);
const change = (label: string, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => {
 Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value: function(this: HTMLDialogElement) { this.setAttribute('open', ''); } },
  close: { configurable: true, value: function(this: HTMLDialogElement) { this.removeAttribute('open'); } },
 });

	controls.role = 'ADMIN';
	controls.visibility = true;
	stored = [1, 2].map((id) => ({
		id,
		year: 2026,
		title: `전시 ${id}`,
		visibility: 'PUBLIC',
		isUploadEnabled: true,
		isModificationEnabled: true,
		sortOrder: id,
		projectCount: 2,
	}));
	vi.spyOn(adminExhibitionApi, 'list').mockImplementation(async () => ({
		items: stored,
	}));
	vi.spyOn(adminExhibitionApi, 'update').mockImplementation(
		async (id, body) => {
			stored = stored.map((item) =>
				item.id === id ? { ...item, ...body } : item,
			);
			return stored.find((item) => item.id === id)!;
		},
	);
	vi.spyOn(adminExhibitionApi, 'delete').mockResolvedValue(undefined);
	vi.spyOn(window, 'confirm').mockReturnValue(true);
	Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
	cleanup();
	client?.clear();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});
describe('exhibition management', () => {
	it('discards cancelled drafts and explicitly clears a saved title', async () => {
		mount();
		await open();
		change('제목', '취소할 값');
		fireEvent.click(screen.getByRole('button', { name: '설정 취소' }));
		await open();
		expect((screen.getByLabelText('제목') as HTMLInputElement).value).toBe(
			'전시 1',
		);
		change('제목', '');
		fireEvent.click(screen.getByRole('button', { name: '설정 저장' }));
		await screen.findByText('전시회 설정이 저장되었습니다.');
		expect(adminExhibitionApi.update).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ title: '' }),
		);
		await open();
		expect((screen.getByLabelText('제목') as HTMLInputElement).value).toBe('');
	});
	it('enables save only for changes and disables it when every setting is restored', async () => {
		mount();
		await open();
		const save = () =>
			screen.getByRole('button', { name: '설정 저장' }) as HTMLButtonElement;
		expect(save().disabled).toBe(true);
		change('제목', '');
		await waitFor(() => expect(save().disabled).toBe(false));
		change('제목', '전시 1');
		await waitFor(() => expect(save().disabled).toBe(true));
		change('노출 순서', '2');
		await waitFor(() => expect(save().disabled).toBe(false));
		change('노출 순서', '1');
		await waitFor(() => expect(save().disabled).toBe(true));
		fireEvent.click(screen.getByLabelText('작품 등록·변경 허용'));
		await waitFor(() => expect(save().disabled).toBe(false));
		fireEvent.click(screen.getByLabelText('작품 등록·변경 허용'));
		await waitFor(() => expect(save().disabled).toBe(true));
		fireEvent.change(screen.getByRole('combobox', { name: '공개 범위' }), { target: { value: (screen.getByRole('option', { name: '로그인 사용자' }) as HTMLOptionElement).value } });
		await waitFor(() => expect(save().disabled).toBe(false));
		fireEvent.change(screen.getByRole('combobox', { name: '공개 범위' }), { target: { value: (screen.getByRole('option', { name: '전체 공개' }) as HTMLOptionElement).value } });
		await waitFor(() => expect(save().disabled).toBe(true));
		expect(adminExhibitionApi.update).not.toHaveBeenCalled();
	});

 it('opens a modal without expanding the row and discards settings on Escape', async () => {
  const { container } = mount(); await open();
  const dialog = screen.getByRole('dialog', { name: '전시회 설정' });
  expect(container.querySelector('.exhibition-item')?.contains(dialog)).toBe(false);
  expect((screen.getByLabelText('연도') as HTMLInputElement).readOnly).toBe(true);
  change('제목', '닫을 초안');
  fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await open(); expect((screen.getByLabelText('제목') as HTMLInputElement).value).toBe('전시 1');
  expect(controls.mounts).toHaveBeenCalledTimes(1);
 });

	it('shows invalid order and title errors without submitting', async () => {
		mount();
		await open();
		change('제목', '가'.repeat(101));
		change('노출 순서', '');
		fireEvent.click(screen.getByRole('button', { name: '설정 저장' }));
		await screen.findByText('제목은 100자 이내로 입력하세요.');
		await screen.findByText('노출 순서는 0 이상의 안전한 정수를 입력하세요.');
		expect(adminExhibitionApi.update).not.toHaveBeenCalled();
	});
	it('lazily mounts uploads and preserves their instance when closing or switching', async () => {
		const { container } = mount();
		await screen.findAllByRole('button', { name: '설정' });
		expect(container.querySelectorAll('input[type=file]')).toHaveLength(0);
		await open();
		expect(controls.mounts).toHaveBeenCalledTimes(1);
		change('제목', '초안');
		fireEvent.click(screen.getByRole('button', { name: '설정 창 닫기' }));
		await open(1);
		expect(controls.mounts).toHaveBeenCalledTimes(2);
		expect(screen.getAllByLabelText('제목')).toHaveLength(1);
		fireEvent.click(screen.getByRole('button', { name: '설정 취소' }));
		await open();
		expect(controls.mounts).toHaveBeenCalledTimes(2);
		expect(controls.unmounts).not.toHaveBeenCalled();
		expect((screen.getByLabelText('제목') as HTMLInputElement).value).toBe(
			'전시 1',
		);
	});
	it('keeps uploads and unsaved settings mounted when a poster refresh completes', async () => {
		mount();
		await open();
		change('제목', '보존할 초안');
		fireEvent.click(screen.getByRole('button', { name: '업로드 완료 재현' }));
		await screen.findByText('포스터가 변경되었습니다.');
		await waitFor(() =>
			expect(adminExhibitionApi.list).toHaveBeenCalledTimes(2),
		);
		expect(controls.unmounts).not.toHaveBeenCalled();
		expect((screen.getByLabelText('제목') as HTMLInputElement).value).toBe(
			'보존할 초안',
		);
	});
	it('reports creation and settings failures while retaining input for retry', async () => {
		vi.spyOn(adminExhibitionApi, 'create').mockRejectedValue(
			new Error('중복 전시회'),
		);
		vi.mocked(adminExhibitionApi.update).mockRejectedValue(
			new Error('저장 실패'),
		);
		mount();
		await open();
		change('제목', '재시도할 값');
		fireEvent.click(screen.getByRole('button', { name: '설정 저장' }));
		await screen.findByText(/설정을 저장하지 못했습니다/);
		expect((screen.getByLabelText('제목') as HTMLInputElement).value).toBe(
			'재시도할 값',
		);
		fireEvent.click(screen.getByRole('button', { name: '설정 취소' }));
		fireEvent.click(screen.getByRole('button', { name: '전시회 추가' }));
		expect(
			(screen.getByRole('button', { name: '추가' }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		fireEvent.change(screen.getByRole('combobox', { name: '공개 범위' }), { target: { value: (screen.getByRole('option', { name: '전체 공개' }) as HTMLOptionElement).value } });
		fireEvent.click(screen.getByRole('button', { name: '추가' }));
		await screen.findByText(/전시회를 추가하지 못했습니다/);
	});

	it('reports deletion failure and describes asynchronous file cleanup', async () => {
		vi.mocked(adminExhibitionApi.delete).mockRejectedValue(
			new Error('삭제 실패 이유'),
		);
		mount();
		await open();
		fireEvent.click(screen.getByRole('button', { name: '전시회 삭제' }));
		expect(window.confirm).toHaveBeenCalledWith(
			expect.stringContaining('WebGL 배포 파일 포함'),
		);
		expect(window.confirm).toHaveBeenCalledWith(
			expect.stringContaining('순차 정리'),
		);
		await screen.findByText(/전시회를 삭제하지 못했습니다/);
	});
	it('shows creation success and highlights the returned exhibition without regrouping', async () => {
		vi.spyOn(adminExhibitionApi, 'create').mockImplementation(async (body) => {
			stored.push({ ...stored[0]!, ...body, id: 3 });
			return { id: 3, year: body.year };
		});
		const { container } = mount();
		await screen.findAllByRole('button', { name: '설정' });
		fireEvent.click(screen.getByRole('button', { name: '전시회 추가' }));
		change('제목', '같은 연도 새 전시');
		fireEvent.change(screen.getByRole('combobox', { name: '공개 범위' }), { target: { value: (screen.getByRole('option', { name: '전체 공개' }) as HTMLOptionElement).value } });
		fireEvent.click(screen.getByRole('button', { name: '추가' }));
		await screen.findByText(/년 전시회가 추가되었습니다/);
		await waitFor(() =>
			expect(
				container.querySelector('.exhibition-summary--new')?.textContent,
			).toContain('같은 연도 새 전시'),
		);
		expect(
			Array.from(container.querySelectorAll('.exhibition-item')).map(
				(item) => item.id,
			),
		).toEqual(['exhibition-1', 'exhibition-2', 'exhibition-3']);
	});
	it('keeps NAS admin-only and respects the visibility feature flag', async () => {
		controls.role = 'OPERATOR';
		controls.visibility = false;
		mount();
		await open();
		expect(screen.queryByText('연도별 NAS 내보내기')).toBeNull();
		expect(screen.queryByRole('combobox', { name: '공개 범위' })).toBeNull();
		change('제목', '변경');
		fireEvent.click(screen.getByRole('button', { name: '설정 저장' }));
		await waitFor(() => expect(adminExhibitionApi.update).toHaveBeenCalled());
		expect(
			vi.mocked(adminExhibitionApi.update).mock.calls[0]?.[1],
		).not.toHaveProperty('visibility');
	});
});
