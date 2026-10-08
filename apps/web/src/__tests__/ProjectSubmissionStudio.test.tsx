/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSubmissionItemStatus, ProjectSubmissionManifestItem } from '../contracts';
import { ProjectSubmissionStudio } from '../features/project-submission/studio/ProjectSubmissionStudio';

const controls = vi.hoisted(() => ({
	role: 'USER',
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
vi.mock('../lib/env', () => ({ env: { VISIBILITY_CONTROLS_ENABLED: true, BASE_PATH: '/' } }));
vi.mock('../features/auth', () => ({
	useMe: () => ({ user: { id: 9, name: '홍길동', studentId: '20260001', role: controls.role } }),
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
	controls.role = 'USER';
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
	controls.role = mode === 'admin' ? 'ADMIN' : 'USER';
	return render(
		<MemoryRouter>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<ProjectSubmissionStudio mode={mode} />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}
async function enterMetadata(visibility: 'PUBLIC' | 'STAFF' | 'AUTHENTICATED' = 'STAFF') {
	const exhibition = await screen.findByLabelText(/전시회/);
	fireEvent.change(exhibition, { target: { value: (await screen.findByRole('option', { name: /2026/ }) as HTMLOptionElement).value } });
	fireEvent.change(screen.getByLabelText('작품명 *'), { target: { value: '선택한 작품' } });
	fireEvent.change(screen.getByLabelText('공개 범위'), { target: { value: visibility } });
}
function select(container: HTMLElement, zone: 'poster' | 'native' | 'web' | 'video' | 'materials', files: File[]) {
	fireEvent.change(container.querySelector(zone === 'poster' ? '.project-upload-drop--poster input[type="file"]' : `[data-file-group="${zone}"] input[type="file"]`)!, {
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

	it('assigns identical ZIPs by area and retains them across steps without uploading', async () => {
		const { container } = mount();
		await enterMetadata();
		await goTo(1);
		const zip = new File(['zip'], 'same.zip', { type: 'application/zip' });
		for (const zone of ['native', 'web', 'materials'] as const) select(container, zone, [zip]);
		await goTo(0);
		await goTo(2);
		expect(controls.upload).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: '작품 제출' }));
		await waitFor(() => expect(controls.upload).toHaveBeenCalledTimes(3));
		expect(items.map(item => item.kind)).toEqual(['GAME', 'WEBGL', 'ATTACHMENT']);
	});

	it.each(['user', 'admin'] as const)('%s sends metadata and all selected file kinds through the existing staged upload flow', async mode => {
		const { container } = mount(mode);
		await enterMetadata('PUBLIC');
		fireEvent.click(screen.getByLabelText('PC'));
		await goTo(1);
		await waitFor(() => expect(controls.config).toHaveBeenCalled());
		select(container, 'poster', [new File(['poster'], 'cover.png', { type: 'image/png' })]);
		select(container, 'native', [new File(['zip'], 'game.zip', { type: 'application/zip' })]);
		select(container, 'web', [new File(['zip'], 'webgl.zip', { type: 'application/zip' })]);
		select(container, 'video', [new File(['video'], 'video.mp4', { type: 'video/mp4' })]);
		select(container, 'materials', [new File(['image'], 'image.png', { type: 'image/png' }), new File(['doc'], 'readme.md', { type: 'text/markdown' })]);
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
	it('preserves an in-flight second image when a status refresh marks the first image READY', async () => {
		const first = new File(['first'], 'first.png', { type: 'image/png' });
		const second = new File(['second'], 'second.png', { type: 'image/png' });
		const poster = new File(['poster'], 'poster.png', { type: 'image/png' });
		let finishPoster!: (value: { status: 'READY'; sessionId: string }) => void;
		controls.upload.mockImplementation((_owner, file: File, kind, _progress, options) => {
			const session = {
				sessionId: file.name,
				owner: { type: 'PROJECT', id: 73 },
				kind,
				generation: 1,
				partSizeBytes: 16,
				totalParts: 1,
				expiresAt: '2026-10-01T00:00:00.000Z',
				sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
				sourceIdentity: 'a'.repeat(64),
			};
			options.onSession(session);
			if (file === first) return Promise.resolve({ status: 'READY', sessionId: file.name });
			if (file === poster)
				return new Promise((resolve) => {
					finishPoster = resolve;
				});
			return new Promise(() => undefined);
		});
		const { container } = mount();
		await enterMetadata();
		await goTo(1);
		select(container, 'poster', [poster]);
		select(container, 'materials', [first, second]);
		await goTo(2);
		fireEvent.click(screen.getByRole('button', { name: '작품 제출' }));
		await waitFor(() => expect(controls.upload).toHaveBeenCalledTimes(3));
		items = items.map((item) =>
			item.slot === 'image:0' || item.kind === 'POSTER' ? { ...item, state: 'READY' } : item,
		);
		await act(async () => {
			finishPoster({ status: 'READY', sessionId: poster.name });
		});
		await waitFor(() => expect(controls.status).toHaveBeenCalledTimes(2));
		expect(controls.upload.mock.calls.map((call) => call[1].name).sort()).toEqual([
			'first.png',
			'poster.png',
			'second.png',
		]);
		const secondCall = controls.upload.mock.calls.find((call) => call[1] === second)!;
		const secondItem = items.find((item) => item.slot === 'image:1')!;
		expect(secondCall[4].submissionItem).toEqual({ id: secondItem.id, clientToken: secondItem.clientToken });
		expect(container.querySelector('[aria-label="사진·설명문·기타 업로드 진행"]')?.textContent).toContain('일시 정지');
	});

	it('advances a reloaded three-image batch from a verifying second file to the remaining third slot', async () => {
		items = ['READY', 'VERIFYING', 'EXPECTED'].map((state, index) => ({
			id: `image-${index}`,
			kind: 'IMAGE',
			slot: `image:${index}`,
			clientToken: `token-${index}`,
			required: true,
			state: state as ProjectSubmissionItemStatus['state'],
		}));
		window.sessionStorage.setItem('pcu.pending-project-submission:user:9', JSON.stringify(draft()));
		const session = {
			sessionId: 'second-session',
			owner: { type: 'PROJECT', id: 73 },
			kind: 'IMAGE',
			generation: 1,
			partSizeBytes: 16,
			totalParts: 1,
			expiresAt: '2026-10-01T00:00:00.000Z',
			sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
			sourceIdentity: 'a'.repeat(64),
		};
		window.sessionStorage.setItem(
			'pcu.direct-image-upload:PROJECT:73',
			JSON.stringify({ session, originalName: 'second.png', totalBytes: 6, completed: 1 }),
		);
		controls.getUploadStatus.mockResolvedValue({ ...session, state: 'VERIFYING' });
		let finish!: (value: unknown) => void;
		controls.waitReady.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const { container } = mount();
		await waitFor(() => expect(controls.waitReady).toHaveBeenCalled());
		items = items.map((item, index) => (index === 1 ? { ...item, state: 'READY' } : item));
		await act(async () => {
			finish({ ...session, state: 'READY' });
		});
		await waitFor(() =>
			expect(container.querySelector('[aria-label="사진·설명문·기타 업로드 진행"] input[type="file"]')).toBeTruthy(),
		);
		const third = new File(['third'], 'third.png', { type: 'image/png' });
		fireEvent.change(container.querySelector('[aria-label="사진·설명문·기타 업로드 진행"] input[type="file"]')!, {
			target: { files: [third] },
		});
		fireEvent.click(screen.getByRole('button', { name: /업로드 시작/ }));
		await waitFor(() => expect(controls.upload).toHaveBeenCalled());
		expect(controls.upload.mock.calls[0]![4].submissionItem).toEqual({
			id: 'image-2',
			clientToken: 'token-2',
		});
	});

	it('retries a failed native build with its original manifest binding', async () => {
		controls.upload.mockRejectedValueOnce(new Error('network failure'));
		const { container } = mount();
		await enterMetadata();
		await goTo(1);
		select(container, 'native', [new File(['zip'], 'retry.zip')]);
		await goTo(2);
		fireEvent.click(screen.getByRole('button', { name: '작품 제출' }));
		fireEvent.click(await screen.findByRole('button', { name: '재시도' }));
		await waitFor(() => expect(controls.upload).toHaveBeenCalledTimes(2));
		expect(controls.upload.mock.calls[1]![4].submissionItem).toEqual(controls.upload.mock.calls[0]![4].submissionItem);
	});
	it('retains the administrator override for a locked exhibition', async () => {
		controls.years.mockResolvedValue({ items: [{ id: 26, year: 2026, title: '잠긴 전시', isUploadEnabled: false }] });
		mount('admin');
		await enterMetadata();
		await goTo(1);
		expect((screen.getByRole('button', { name: '네이티브 빌드 파일 선택' }) as HTMLButtonElement).disabled).toBe(false);
		await goTo(2);
		fireEvent.click(screen.getByRole('button', { name: '작품 등록' }));
		await waitFor(() => expect(controls.submit).toHaveBeenCalledOnce());
	});

});

describe.each(['user', 'admin'] as const)('%s public asset requirements', mode => {
	const required = [
		{ zone: 'native', label: '네이티브 빌드', name: 'native.zip' },
		{ zone: 'web', label: '웹 빌드', name: 'web.zip' },
		{ zone: 'video', label: '동영상', name: 'video.mp4' },
		{ zone: 'materials', label: '사진', name: 'photo.png' },
	] as const;
	it.each(required)('requires $label and updates the checklist after selection and removal', async missing => {
		const { container } = mount(mode);
		await enterMetadata('PUBLIC');
		await goTo(1);
		select(container, 'poster', [new File(['poster'], 'poster.png')]);
		select(container, 'materials', [new File(['document'], 'description.pdf'), new File(['other'], 'source.zip')]);
		for (const entry of required) {
			if (entry !== missing) select(container, entry.zone, [new File(['data'], entry.name)]);
		}
		const checklist = screen.getByRole('region', { name: '필수 정보 준비' });
		expect(within(checklist).getByText(missing.label).closest('li')?.textContent).toContain('파일 필요');
		expect(within(checklist).getByText('6 / 7')).toBeTruthy();
		await goTo(2);
		const submitName = mode === 'admin' ? '작품 등록' : '작품 제출';
		expect((screen.getByRole('button', { name: submitName }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.submit(container.querySelector('form')!);
		expect(controls.submit).not.toHaveBeenCalled();
		expect(controls.upload).not.toHaveBeenCalled();
		await goTo(1);
		select(container, missing.zone, [new File(['data'], missing.name)]);
		expect(within(checklist).getByText(missing.label).closest('li')?.textContent).toContain('선택 완료');
		expect(within(checklist).getByText('7 / 7')).toBeTruthy();
		await goTo(2);
		expect((screen.getByRole('button', { name: submitName }) as HTMLButtonElement).disabled).toBe(false);
		await goTo(1);
		fireEvent.click(screen.getByRole('button', { name: `${missing.name} 선택 취소` }));
		expect(within(checklist).getByText('6 / 7')).toBeTruthy();
		await goTo(2);
		expect((screen.getByRole('button', { name: submitName }) as HTMLButtonElement).disabled).toBe(true);
	});
	it.each(['STAFF', 'AUTHENTICATED'] as const)('allows %s without assets and blocks when changed to PUBLIC', async visibility => {
		const { container } = mount(mode);
		await enterMetadata(visibility);
		const checklist = screen.getByRole('region', { name: '필수 정보 준비' });
		expect(within(checklist).getByText('3 / 3')).toBeTruthy();
		expect(within(checklist).getAllByText('선택 안 함')).toHaveLength(4);
		await goTo(2);
		const name = mode === 'admin' ? '작품 등록' : '작품 제출';
		expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false);
		await goTo(0);
		fireEvent.change(screen.getByLabelText('공개 범위'), { target: { value: 'PUBLIC' } });
		expect(within(checklist).getByText('3 / 7')).toBeTruthy();
		await goTo(2);
		fireEvent.submit(container.querySelector('form')!);
		expect(controls.submit).not.toHaveBeenCalled();
		await goTo(0);
		fireEvent.change(screen.getByLabelText('공개 범위'), { target: { value: visibility } });
		await goTo(2);
		fireEvent.click(screen.getByRole('button', { name }));
		await waitFor(() => expect(controls.submit).toHaveBeenCalledOnce());
	});
});
