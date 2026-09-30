/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSubmissionItemStatus, ProjectSubmissionManifestItem } from '../contracts';
import type { DirectAssetUploadSession } from '../lib/api/game-upload';
import { ProjectSubmissionForm } from '../features/project-submission/ProjectSubmissionForm';

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
	vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:poster'), revokeObjectURL: vi.fn() });
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
				<ProjectSubmissionForm mode={mode} />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}
async function enterMetadata() {
	fireEvent.click(await screen.findByRole('combobox'));
	fireEvent.click(screen.getByRole('option', { name: /2026/ }));
	fireEvent.change(screen.getByLabelText('제목 *'), { target: { value: '선택한 작품' } });
}
function select(container: HTMLElement, zone: 'poster' | 'files', files: File[]) {
	fireEvent.change(container.querySelector(`.project-upload-drop--${zone} input[type="file"]`)!, {
		target: { files },
	});
}

describe.each(['admin', 'user'] as const)('%s registration shared layout', (mode) => {
	it('opens modal help without choosing files or submitting, and restores focus on dismissal', async () => {
		const { container } = mount(mode);
		await enterMetadata();
		const inputClicks = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'))
			.map((input) => vi.spyOn(input, 'click'));
		for (const label of ['포스터 사용 방법', '파일 업로드 사용 방법']) {
			const trigger = screen.getByRole('button', { name: label });
			trigger.focus();
			fireEvent.click(trigger);
			const dialog = screen.getByRole('dialog', { name: label });
			expect(container.contains(dialog)).toBe(false);
			expect(document.body.style.overflow).toBe('hidden');
			const close = within(dialog).getByRole('button', { name: '도움말 닫기' });
			expect(document.activeElement).toBe(close);
			if (label === '포스터 사용 방법') fireEvent.click(close);
			else fireEvent.keyDown(document, { key: 'Escape' });
			expect(screen.queryByRole('dialog')).toBeNull();
			expect(document.activeElement).toBe(trigger);
			expect(document.body.style.overflow).toBe('');
		}
		expect(inputClicks.every((click) => click.mock.calls.length === 0)).toBe(true);
		expect(controls.submit).not.toHaveBeenCalled();
		expect(controls.upload).not.toHaveBeenCalled();
	});

	it('navigates help steps, traps focus, and preserves selected files when help closes', async () => {
		const { container } = mount(mode);
		await enterMetadata();
		select(container, 'files', [new File(['game'], 'game.zip', { type: 'application/zip' })]);
		const trigger = screen.getByRole('button', { name: '파일 업로드 사용 방법' });
		fireEvent.click(trigger);
		const dialog = screen.getByRole('dialog', { name: '파일 업로드 사용 방법' });
		const help = within(dialog);
		expect(help.getByRole('button', { name: '이전' }).hasAttribute('disabled')).toBe(true);
		const close = help.getByRole('button', { name: '도움말 닫기' });
		fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
		expect(document.activeElement).toBe(help.getByRole('button', { name: '다음' }));
		fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
		expect(document.activeElement).toBe(close);
		fireEvent.click(help.getByRole('button', { name: '다음' }));
		expect(help.getByRole('button', { name: '이전' }).hasAttribute('disabled')).toBe(false);
		fireEvent.click(help.getByRole('button', { name: '4단계: 작품 제출' }));
		fireEvent.click(help.getByRole('button', { name: '확인' }));
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.getByText('game.zip')).toBeTruthy();
		fireEvent.click(trigger);
		expect(within(screen.getByRole('dialog')).getByRole('button', { name: '이전' }).hasAttribute('disabled')).toBe(true);
		fireEvent.click(screen.getByRole('dialog').parentElement!);
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(controls.submit).not.toHaveBeenCalled();
		expect(controls.upload).not.toHaveBeenCalled();
	});

	it('keeps mixed selection local until metadata creates a DRAFT, then preserves manifest tokens in side-column uploads', async () => {
		const { container } = mount(mode);
		await enterMetadata();
		const poster = new File(['poster'], 'poster.png', { type: 'image/png' });
		const image = new File(['image'], 'image.png', { type: 'image/png' });
		const video = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
		const document = new File(['doc'], 'guide.md', { type: 'text/markdown' });
		const game = new File(['game'], 'game.zip', { type: 'application/zip' });
		const webgl = new File(['webgl'], 'webgl.zip', { type: 'application/zip' });
		await waitFor(() => expect(controls.config).toHaveBeenCalledOnce());
		select(container, 'poster', [poster]);
		select(container, 'files', [image, video, document, game, webgl]);
		const zipRow = (name: string) => screen.getByText(name).closest('li')!;
		fireEvent.click(within(zipRow('game.zip')).getByRole('button', { name: '게임' }));
		fireEvent.click(within(zipRow('webgl.zip')).getByRole('button', { name: 'WebGL' }));
		expect(controls.submit).not.toHaveBeenCalled();
		expect(controls.upload).not.toHaveBeenCalled();
		expect(container.querySelectorAll('input[type="file"]')).toHaveLength(2);
		fireEvent.click(screen.getByRole('button', { name: mode === 'admin' ? '작품 등록' : '작품 제출' }));
		await waitFor(() => expect(controls.upload).toHaveBeenCalledTimes(6));
		expect(controls.getApi).toHaveBeenCalledWith(mode);
		const formData = controls.submit.mock.calls[0]![0].formData as FormData;
		expect(Array.from(formData.keys())).toEqual(['payload']);
		expect(items.map((item) => item.kind).sort()).toEqual([
			'DOCUMENT',
			'GAME',
			'IMAGE',
			'POSTER',
			'VIDEO',
			'WEBGL',
		]);
		for (const call of controls.upload.mock.calls) {
			const kind = call[2];
			const item = items.find((candidate) => candidate.kind === kind)!;
			expect(call[4].submissionItem).toEqual({ id: item.id, clientToken: item.clientToken });
		}
		expect(
			within(container.querySelector('.admin-project-edit-poster')!).getByText('poster.png'),
		).toBeTruthy();
		expect(within(container.querySelector('.admin-project-edit-assets')!).getByText('game.zip')).toBeTruthy();
		expect(container.querySelector('input[type="file"]')).toBeNull();
		expect(window.sessionStorage.getItem(`pcu.pending-project-submission:${mode}`)).toContain(
			'submission-73',
		);
	});
});

describe('submission selection and recovery', () => {
	it('blocks registration, including direct form submit, until all ZIP purposes are chosen', async () => {
		const { container } = mount();
		await enterMetadata();
		select(container, 'files', [new File(['archive'], 'archive.zip', { type: 'application/zip' })]);
		expect((screen.getByRole('button', { name: '작품 제출' }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.getByRole('button', { name: '첨부자료' })).toBeTruthy();
		fireEvent.submit(container.querySelector('form')!);
		await act(async () => {
			await Promise.resolve();
		});
		expect(controls.submit).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole('button', { name: '게임' }));
		expect((screen.getByRole('button', { name: '작품 제출' }) as HTMLButtonElement).disabled).toBe(false);
	});

	it('preserves an in-flight second image when a status refresh marks the first image READY', async () => {
		const first = new File(['first'], 'first.png', { type: 'image/png' });
		const second = new File(['second'], 'second.png', { type: 'image/png' });
		const poster = new File(['poster'], 'poster.png', { type: 'image/png' });
		let finishPoster!: (value: { status: 'READY'; sessionId: string }) => void;
		controls.upload.mockImplementation((_owner, file: File, kind, _progress, options) => {
			const session: DirectAssetUploadSession = {
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
		select(container, 'poster', [poster]);
		select(container, 'files', [first, second]);
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
		expect(container.querySelector('.admin-project-edit-assets')?.textContent).toContain('일시 정지');
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
		window.sessionStorage.setItem('pcu.pending-project-submission:user', JSON.stringify(draft()));
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
			expect(container.querySelector('.admin-project-edit-assets input[type="file"]')).toBeTruthy(),
		);
		const third = new File(['third'], 'third.png', { type: 'image/png' });
		fireEvent.change(container.querySelector('.admin-project-edit-assets input[type="file"]')!, {
			target: { files: [third] },
		});
		fireEvent.click(screen.getByRole('button', { name: /업로드 시작/ }));
		await waitFor(() => expect(controls.upload).toHaveBeenCalled());
		expect(controls.upload.mock.calls[0]![4].submissionItem).toEqual({
			id: 'image-2',
			clientToken: 'token-2',
		});
	});

	it('retains existing file recovery inputs after reloading a pending DRAFT without browser files', async () => {
		items = [
			{
				id: 'poster-item',
				kind: 'POSTER',
				slot: 'poster',
				clientToken: 'poster-token',
				required: true,
				state: 'EXPECTED',
			},
			{
				id: 'game-item',
				kind: 'GAME',
				slot: 'game',
				clientToken: 'game-token',
				required: true,
				state: 'EXPECTED',
			},
		];
		window.sessionStorage.setItem('pcu.pending-project-submission:user', JSON.stringify(draft()));
		const { container } = mount();
		await screen.findByText('제출 취소');
		expect(container.querySelector('.admin-project-edit-poster input[type="file"]')).toBeTruthy();
		expect(container.querySelector('.admin-project-edit-assets input[type="file"]')).toBeTruthy();
		expect(controls.submit).not.toHaveBeenCalled();
		expect(controls.upload).not.toHaveBeenCalled();
		controls.cancel.mockResolvedValue(undefined);
		fireEvent.click(screen.getByRole('button', { name: '제출 취소' }));
		await waitFor(() => expect(controls.cancel).toHaveBeenCalledWith(73));
		await waitFor(() =>
			expect(window.sessionStorage.getItem('pcu.pending-project-submission:user')).toBeNull(),
		);
	});
});
