/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSubmissionItemStatus, ProjectSubmissionManifestItem } from '../contracts';
import { ProjectSubmissionStudio } from '../features/project-submission/studio/ProjectSubmissionStudio';

const controls = vi.hoisted(() => ({
	config: vi.fn(),
	years: vi.fn(),
	getApi: vi.fn(),
	submit: vi.fn(),
	status: vi.fn(),
	finalize: vi.fn(),
	cancel: vi.fn(),
	upload: vi.fn(),
	getUploadStatus: vi.fn(),
	cancelUpload: vi.fn(),
	waitReady: vi.fn(),
}));
vi.mock('../features/auth', () => ({
	useMe: () => ({ user: { id: 9, name: '홍길동', studentId: '20260001', role: 'USER' } }),
}));
vi.mock('../lib/api', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/api')>()),
	publicApi: { getUploadConfig: controls.config },
	adminExhibitionApi: { list: controls.years },
}));
vi.mock('../lib/api/project-submit', () => ({ getProjectSubmitApi: controls.getApi }));
vi.mock('../lib/api/game-upload', () => ({
	uploadDirectAssetFile: controls.upload,
	getDirectAssetUploadStatus: controls.getUploadStatus,
	cancelDirectAssetUploadSession: controls.cancelUpload,
	waitForDirectAssetReady: controls.waitReady,
}));

let items: ProjectSubmissionItemStatus[];
const draft = () => ({
	id: 73,
	slug: 'new-project',
	year: 2026,
	status: 'DRAFT',
	submissionId: 'submission-73',
	items,
	adminEditUrl: '/admin/projects/73/edit',
});
beforeEach(() => {
	items = [];
	class TestURL extends URL {}
	TestURL.createObjectURL = vi.fn(() => 'blob:poster');
	TestURL.revokeObjectURL = vi.fn();
	vi.stubGlobal('URL', TestURL);
	Element.prototype.scrollIntoView = vi.fn();
	controls.config.mockResolvedValue({ materialMaxCount: 10, materialMaxBytes: 50 * 1024 * 1024 });
	controls.years.mockResolvedValue({
		items: [{ id: 26, year: 2026, title: '졸업전시', isUploadEnabled: true, isModificationEnabled: true }],
	});
	controls.getApi.mockReturnValue({
		submit: controls.submit,
		getSubmission: controls.status,
		finalizeSubmission: controls.finalize,
		cancelSubmission: controls.cancel,
	});
	controls.submit.mockImplementation(({ formData }: { formData: FormData }) => {
		const payload = JSON.parse(String(formData.get('payload'))) as {
			manifest: ProjectSubmissionManifestItem[];
		};
		items = payload.manifest.map((item, index) => ({ ...item, id: `item-${index}`, state: 'EXPECTED' }));
		return Promise.resolve(draft());
	});
	controls.status.mockImplementation(() => Promise.resolve({ state: 'PENDING', items }));
	controls.upload.mockImplementation(() => new Promise(() => undefined));
});
afterEach(() => {
	cleanup();
	window.sessionStorage.clear();
	vi.resetAllMocks();
	vi.unstubAllGlobals();
});

function mount(mode: 'admin' | 'user' = 'user') {
	return render(
		<MemoryRouter>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<ProjectSubmissionStudio mode={mode} />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}
async function enterMetadata() {
	const exhibition = await screen.findByRole('combobox');
	fireEvent.change(exhibition, { target: { value: (await screen.findByRole('option', { name: /2026/ }) as HTMLOptionElement).value } });
	fireEvent.change(screen.getByLabelText('작품명 *'), { target: { value: '선택한 작품' } });
}
function select(container: HTMLElement, zone: 'poster' | 'files', files: File[]) {
	fireEvent.change(container.querySelector(`.project-upload-drop--${zone} input[type="file"]`)!, {
		target: { files },
	});
}

async function goTo(step: number) {
	fireEvent.click(screen.getByRole('navigation', { name: '작품 작성 단계' }).querySelectorAll('button')[step]!);
	await act(async () => { await Promise.resolve(); });
}

describe('submission studio', () => {
	it('updates the live preview and routes invalid hidden fields back to the right step', async () => {
		mount();
		await enterMetadata();
		expect(within(screen.getByRole('article', { name: '전시 카드 미리보기' })).getByRole('heading', { name: '선택한 작품' })).toBeTruthy();
		await goTo(2);
		fireEvent.change(screen.getByLabelText('작품명 *'), { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: '작품 제출' }));
		await screen.findByText('제목을 입력하세요.');
		expect(screen.getByLabelText('작품명 *').closest('[hidden]')).toBeNull();
		expect(controls.submit).not.toHaveBeenCalled();
	});

	it('uses the exhibition card and supports both public display modes', async () => {
		mount();
		await enterMetadata();
		const card = screen.getByRole('article', { name: '전시 카드 미리보기' });
		expect(card.classList.contains('archive-grid--poster')).toBe(true);
		expect(within(card).getByText('20260001 홍길동')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: '카드형' }));
		expect(card.classList.contains('archive-grid--poster')).toBe(false);
		fireEvent.click(within(card).getByRole('button'));
		expect(screen.getByRole('dialog', { name: '작품 미리보기' })).toBeTruthy();
	});

	it('does not create a submission when Enter submits an earlier step', async () => {
		const { container } = mount();
		await enterMetadata();
		fireEvent.submit(container.querySelector('form')!);
		await screen.findByRole('heading', { name: '팀과 자료' });
		expect(controls.submit).not.toHaveBeenCalled();
	});

	it('retains unclassified ZIPs and blocks direct submission until a purpose is selected', async () => {
		const { container } = mount();
		await enterMetadata();
		await goTo(1);
		select(container, 'files', [new File(['zip'], 'pending.zip', { type: 'application/zip' })]);
		await goTo(0);
		await goTo(2);
		expect((screen.getByRole('button', { name: '작품 제출' }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.submit(container.querySelector('form')!);
		expect(controls.submit).not.toHaveBeenCalled();
		await goTo(1);
		expect(screen.getByText('pending.zip')).toBeTruthy();
		fireEvent.click(screen.getByRole('button', { name: '게임' }));
		await goTo(2);
		fireEvent.click(screen.getByRole('button', { name: '작품 제출' }));
		await waitFor(() => expect(controls.upload).toHaveBeenCalledOnce());
	});

	it.each(['user', 'admin'] as const)('%s sends metadata and all selected file kinds through the existing staged upload flow', async mode => {
		const { container } = mount(mode);
		await enterMetadata();
		fireEvent.click(screen.getByLabelText('PC'));
		await goTo(1);
		await waitFor(() => expect(controls.config).toHaveBeenCalled());
		select(container, 'poster', [new File(['poster'], 'cover.png', { type: 'image/png' })]);
		select(container, 'files', [
			new File(['zip'], 'game.zip', { type: 'application/zip' }),
			new File(['zip'], 'webgl.zip', { type: 'application/zip' }),
			new File(['image'], 'image.png', { type: 'image/png' }),
			new File(['video'], 'video.mp4', { type: 'video/mp4' }),
			new File(['doc'], 'readme.md', { type: 'text/markdown' }),
		]);
		fireEvent.click(within(screen.getByText('game.zip').closest('li')!).getByRole('button', { name: '게임' }));
		fireEvent.click(within(screen.getByText('webgl.zip').closest('li')!).getByRole('button', { name: 'WebGL' }));
		await goTo(0);
		await goTo(2);
		expect(controls.upload).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: mode === 'admin' ? '작품 등록' : '작품 제출' }));
		await waitFor(() => expect(controls.upload).toHaveBeenCalledTimes(6));
		expect(controls.getApi).toHaveBeenCalledWith(mode);
		const data = controls.submit.mock.calls[0]![0].formData as FormData;
		expect([...data.keys()]).toEqual(['payload']);
		expect(JSON.parse(String(data.get('payload')))).toMatchObject({ title: '선택한 작품', platforms: ['PC'] });
		expect(items.map(item => item.kind).sort()).toEqual(['DOCUMENT', 'GAME', 'IMAGE', 'POSTER', 'VIDEO', 'WEBGL']);
		for (const call of controls.upload.mock.calls) {
			const item = items.find(item => item.kind === call[2])!;
			expect(call[4].submissionItem).toEqual({ id: item.id, clientToken: item.clientToken });
		}
		expect(screen.getByRole('region', { name: '제출 진행 상태' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: '작품 제출' })).toBeNull();
	});

	it('enforces the user exhibition lock even on a direct submit event', async () => {
		controls.years.mockResolvedValue({ items: [{ id: 26, year: 2026, title: '잠긴 전시', isUploadEnabled: false }] });
		const { container } = mount();
		await enterMetadata();
		await goTo(2);
		expect((screen.getByRole('button', { name: '작품 제출' }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.submit(container.querySelector('form')!);
		expect(controls.submit).not.toHaveBeenCalled();
	});

	it('restores a staged submission and keeps cancellation available', async () => {
		items = [{ id: 'item-1', kind: 'GAME', slot: 'game', clientToken: 'a'.repeat(32), required: true, state: 'EXPECTED' }];
		window.sessionStorage.setItem('pcu.pending-project-submission:user:9', JSON.stringify(draft()));
		mount();
		await screen.findByRole('region', { name: '제출 진행 상태' });
		await waitFor(() => expect(controls.status).toHaveBeenCalledWith(73));
		expect(screen.queryByRole('textbox', { name: /작품명/ })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: '제출 취소' }));
		await waitFor(() => expect(controls.cancel).toHaveBeenCalledWith(73));
	});
});
