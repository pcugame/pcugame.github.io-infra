/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdminProjectDetail } from '@pcu/contracts';
import {
	AdminProjectAssetManager,
	AdminProjectPosterUpload,
	AdminProjectUploadProvider,
	useAdminProjectUploadQueue,
} from '../features/admin/projects/AdminProjectAssetManager';
import { adminAssetApi, adminProjectApi, publicApi } from '../lib/api';
import { userProjectApi } from '../lib/api/me';
import { getClientUploadLimits } from '../lib/upload-limits';
import {
	classifyProjectFile,
	uploadQueueIssues,
	type UploadEntry,
} from '../lib/upload/project-files';
const api = vi.hoisted(() => ({
	uploadDirectAssetFile: vi.fn(),
	waitForDirectAssetReady: vi.fn(),
	getDirectAssetUploadStatus: vi.fn(),
	cancelDirectAssetUploadSession: vi.fn(),
}));
vi.mock('../lib/api/game-upload', () => api);
const viewer = vi.hoisted(() => ({ role: 'ADMIN' }));
vi.mock('../features/auth', () => ({ useMe: () => ({ user: { id: 3, role: viewer.role } }) }));
const project: AdminProjectDetail = {
	visibility: 'PUBLIC', exhibitionVisibility: 'PUBLIC', canChangeVisibility: false,
	id: 7,
	title: '작품',
	slug: 'project',
	year: 2026,
	platforms: [],
	isIncomplete: false,
	video: null,
	videos: [],
	status: 'PUBLISHED',
	sortOrder: 0,
	members: [],
	assets: [
		{ id: 11, kind: 'VIDEO', url: '/asset/11', originalName: 'existing.mp4', size: 1024, videoSortOrder: 0 },
	],
};
const limits = getClientUploadLimits('ADMIN');
function ApplyControl() {
	const queue = useAdminProjectUploadQueue();
	return <><button onClick={() => void queue.applyChanges().catch(() => {})}>적용</button>
		<span data-testid="dirty">{String(queue.hasChanges)}</span><span data-testid="applying">{String(queue.isApplying)}</span></>;
}
function apply() { fireEvent.click(screen.getByRole('button', { name: '적용' })); }
function setup(enabled = true, detail = project) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return {
		client,
		...render(
			<QueryClientProvider client={client}>
				<AdminProjectUploadProvider project={detail} projectId={7} limits={limits} canEditContent={enabled}>
					<ApplyControl />
					<AdminProjectPosterUpload project={detail} canEditContent={enabled} />
					<AdminProjectAssetManager canEditContent={enabled} />
				</AdminProjectUploadProvider>
			</QueryClientProvider>,
		),
	};
}
function drop(files: File[], poster = false) {
	fireEvent.drop(
		screen.getByRole('button', { name: poster ? '포스터 파일 선택' : '게임·미디어·자료 선택' }).parentElement!,
		{ dataTransfer: { files, types: ['Files'] } },
	);
}
const file = (name: string, type = '') => new File(['x'], name, { type });
beforeEach(() => {
	viewer.role = 'ADMIN';
	vi.spyOn(publicApi, 'getUploadConfig').mockResolvedValue({
		materialMaxCount: 3,
		materialMaxBytes: 1024,
	} as Awaited<ReturnType<typeof publicApi.getUploadConfig>>);
	api.uploadDirectAssetFile.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.resetAllMocks();
	sessionStorage.clear();
});
it.each([
	['GAME', 'game.zip', false],
	['VIDEO', 'video.mp4', false],
	['POSTER', 'poster.png', true],
] as const)('binds a draft %s retry to its submission item', async (kind, name, poster) => {
	const binding = { id: 'submission-item', clientToken: 'a'.repeat(32) };
	vi.spyOn(adminProjectApi, 'getSubmission').mockResolvedValue({
		submissionId: 'submission', projectId: 7, projectStatus: 'DRAFT', state: 'PENDING',
		items: [{ ...binding, kind, slot: kind.toLowerCase(), required: true, state: 'FAILED' }],
	});
	api.uploadDirectAssetFile.mockResolvedValue({ status: 'READY', sessionId: 'retry' });
	setup(true, { ...project, status: 'DRAFT' });
	drop([file(name)], poster);
	if (kind === 'GAME') fireEvent.click(screen.getByRole('button', { name: '게임' }));
	apply();
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce());
	expect(api.uploadDirectAssetFile.mock.calls[0]![4]).toMatchObject({ submissionItem: binding });
	await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe('false'));
});

it('does not send an unbound upload when draft status cannot be loaded', async () => {
	vi.spyOn(adminProjectApi, 'getSubmission').mockRejectedValue(new Error('offline'));
	setup(true, { ...project, status: 'DRAFT' });
	drop([file('poster.png')], true);
	apply();
	await waitFor(() => expect(adminProjectApi.getSubmission).toHaveBeenCalledOnce());
	await waitFor(() => expect(screen.getByTestId('applying').textContent).toBe('false'));
	expect(api.uploadDirectAssetFile).not.toHaveBeenCalled();
	expect(screen.getByTestId('dirty').textContent).toBe('true');
});
it('clears the draft binding when uploading again after publication', async () => {
	vi.spyOn(adminProjectApi, 'getSubmission').mockResolvedValue({
		submissionId: 'submission', projectId: 7, projectStatus: 'DRAFT', state: 'PENDING',
		items: [{ id: 'item', clientToken: 'a'.repeat(32), kind: 'IMAGE', slot: 'image:0', required: true, state: 'EXPECTED' }],
	});
	api.uploadDirectAssetFile.mockResolvedValue({ status: 'READY', sessionId: 'ready' });
	const { client, rerender } = setup(true, { ...project, status: 'DRAFT' });
	drop([file('first.png')]);
	apply();
	await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe('false'));
	rerender(<QueryClientProvider client={client}>
		<AdminProjectUploadProvider project={project} projectId={7} limits={limits} canEditContent>
			<ApplyControl />
			<AdminProjectPosterUpload project={project} canEditContent />
			<AdminProjectAssetManager canEditContent />
		</AdminProjectUploadProvider>
	</QueryClientProvider>);
	drop([file('second.png')]);
	apply();
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(2));
	expect(api.uploadDirectAssetFile.mock.calls[0]![4].submissionItem).toBeDefined();
	expect(api.uploadDirectAssetFile.mock.calls[1]![4].submissionItem).toBeUndefined();
	await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe('false'));
});
it.each([
	['A.JPG', '', 'IMAGE'],
	['A.WebP', '', 'IMAGE'],
	['blob', 'image/png', 'IMAGE'],
	['a.MOV', '', 'VIDEO'],
	['a.webm', '', 'VIDEO'],
	['a.PDF', '', 'DOCUMENT'],
	['a.docx', '', 'DOCUMENT'],
	['a', 'text/plain', 'DOCUMENT'],
	['a.XLSX', '', 'DOCUMENT'],
	['a.bin', '', 'ATTACHMENT'],
	['a.gif', '', 'ATTACHMENT'],
	['a.ZIP', '', 'ZIP'],
])('classifies %s with MIME %s as %s', (name, type, kind) =>
	expect(classifyProjectFile(file(name, type), 'files')).toBe(kind),
);
it('classifies PDF by destination and rejects unsupported posters', () => {
	expect(classifyProjectFile(file('a.pdf'), 'poster')).toBe('POSTER');
	expect(classifyProjectFile(file('a.gif'), 'poster')).toBeNull();
});
it('reserves counts across stored and queued files and enforces bytes', () => {
	const entries: UploadEntry[] = ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4', 'e.mp4'].map((name, id) => ({
		id,
		file: file(name),
		kind: 'VIDEO',
		zone: 'files',
		status: 'pending',
	}));
	expect(uploadQueueIssues(entries, project, limits).get(4)).toMatch(/최대 5개/);
	const materials: UploadEntry[] = ['a.pdf', 'a.bin', 'b.pdf', 'b.bin'].map((name, id) => ({
		id,
		file: file(name),
		kind: id % 2 ? 'ATTACHMENT' : 'DOCUMENT',
		zone: 'files',
		status: 'pending',
	}));
	expect(uploadQueueIssues(materials, project, limits, { maxCount: 3, maxBytes: 1 }).get(3)).toMatch(
		/최대 3개/,
	);
	expect(uploadQueueIssues(materials, project, limits, { maxCount: 3, maxBytes: 0 }).get(0)).toMatch(
		/파일당 최대/,
	);
});
it('shows stored files but denies changes without permission', () => {
	setup(false);
	expect(screen.queryByText('등록된 자산')).toBeNull();
	expect(screen.getByText('existing.mp4')).toBeTruthy();
	for (const name of ['삭제', '메인으로 지정', '포스터로 지정', '위로', '아래로'])
		expect(screen.queryByRole('button', { name })).toBeNull();
	expect((screen.getByRole('button', { name: '게임·미디어·자료 선택' }) as HTMLButtonElement).disabled).toBe(true);
	drop([file('a.jpg')]);
	expect(api.uploadDirectAssetFile).not.toHaveBeenCalled();
});
it('rejects multiple posters and accepts PDF on the whole preview', async () => {
	setup();
	drop([file('a.jpg'), file('b.jpg')], true);
	expect(screen.getByRole('alert').textContent).toMatch(/한 개/);
	expect(api.uploadDirectAssetFile).not.toHaveBeenCalled();
	drop([file('a.pdf')], true);
	expect(api.uploadDirectAssetFile).not.toHaveBeenCalled();
	apply();
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce());
	expect(api.uploadDirectAssetFile.mock.calls[0]![2]).toBe('POSTER');
});
it('stages mixed files, validates ZIP before any writes, and uploads sequentially on Apply', async () => {
	const resolvers: Array<(value: unknown) => void> = [];
	api.uploadDirectAssetFile.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
	setup();
	drop([file('a.jpg'), file('game.zip'), file('b.mp4')]);
	expect(screen.getByTestId('dirty').textContent).toBe('true');
	apply();
	expect(api.uploadDirectAssetFile).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole('button', { name: '게임' }));
	apply();
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(1));
	await act(async () => resolvers[0]!({ status: 'READY', sessionId: 'one' }));
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(2));
	expect(api.uploadDirectAssetFile.mock.calls[1]![1].name).toBe('game.zip');
	await act(async () => resolvers[1]!({ status: 'READY', sessionId: 'two' }));
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(3));
	await act(async () => resolvers[2]!({ status: 'READY', sessionId: 'three' }));
	await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe('false'));
});
it('blocks all uploads on missing material config and retries settings', async () => {
	vi.mocked(publicApi.getUploadConfig).mockRejectedValueOnce(new Error('offline'));
	setup();
	drop([file('a.pdf'), file('b.mp4')]);
	apply();
	expect(api.uploadDirectAssetFile).not.toHaveBeenCalled();
	await waitFor(() => expect((screen.getByRole('button', { name: '설정 재시도' }) as HTMLButtonElement).disabled).toBe(false));
	fireEvent.click(screen.getByRole('button', { name: '설정 재시도' }));
	await waitFor(() => expect(publicApi.getUploadConfig).toHaveBeenCalledTimes(2));
	await waitFor(() => expect(screen.queryByText('자료 업로드 설정을 불러오는 중입니다.')).toBeNull());
	apply();
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce());
});
it('retries failed upload from Apply and does not repeat completed transfers', async () => {
	api.uploadDirectAssetFile.mockResolvedValueOnce({ status: 'READY', sessionId: 'one' })
		.mockRejectedValueOnce(new Error('전송 실패'))
		.mockResolvedValueOnce({ status: 'READY', sessionId: 'two' });
	setup();
	drop([file('a.jpg'), file('b.mp4')]);
	apply();
	await screen.findByRole('button', { name: '재시도' });
	await waitFor(() => expect(screen.getByTestId('applying').textContent).toBe('false'));
	expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(2);
	apply();
	await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe('false'));
	expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(3);
	expect(api.uploadDirectAssetFile.mock.calls[2]![1].name).toBe('b.mp4');
});
it('cancellation and deletion undo return to clean without API writes', () => {
	const remove = vi.spyOn(adminAssetApi, 'remove').mockResolvedValue();
	setup();
	drop([file('a.jpg')]);
	fireEvent.click(screen.getByRole('button', { name: '취소' }));
	expect(screen.getByTestId('dirty').textContent).toBe('false');
	fireEvent.click(screen.getByRole('button', { name: '삭제' }));
	expect(screen.getByTestId('dirty').textContent).toBe('true');
	expect(remove).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole('button', { name: '삭제 취소' }));
	expect(screen.getByTestId('dirty').textContent).toBe('false');
});
it('applies staged deletes before uploads and does not repeat a successful delete on retry', async () => {
	const remove = vi.spyOn(adminAssetApi, 'remove').mockResolvedValue();
	api.uploadDirectAssetFile.mockRejectedValueOnce(new Error('실패')).mockResolvedValueOnce({ status: 'READY', sessionId: 'one' });
	setup();
	fireEvent.click(screen.getByRole('button', { name: '삭제' }));
	drop([file('a.jpg')]);
	expect(remove).not.toHaveBeenCalled();
	apply();
	await screen.findByRole('button', { name: '재시도' });
	// The widget error renders before the parent Apply promise finishes.
	// Production disables Apply until that promise settles; wait for the same boundary.
	await waitFor(() => expect(screen.getByTestId('applying').textContent).toBe('false'));
	expect(remove).toHaveBeenCalledExactlyOnceWith(11);
	apply();
	await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe('false'));
	expect(remove).toHaveBeenCalledOnce();
	expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(2);
});
it('highlights both drop areas when a file enters the window, emphasizes its target, and resets on leave', () => {
	const { container } = setup();
	const dataTransfer = { types: ['Files'], files: [file('a.jpg')] };
	fireEvent.dragEnter(document.body, { dataTransfer });
	expect(container.querySelectorAll('.is-file-dragging')).toHaveLength(2);
	const zone = container.querySelector('.project-upload-drop--files')!;
	fireEvent.dragEnter(zone, { dataTransfer });
	expect(zone.classList.contains('is-drag-over')).toBe(true);
	expect(screen.getByText('여기에 놓으세요')).toBeTruthy();
	fireEvent.dragLeave(zone, { dataTransfer });
	expect(zone.classList.contains('is-drag-over')).toBe(false);
	fireEvent.dragLeave(document.body, { dataTransfer });
	expect(container.querySelectorAll('.is-file-dragging')).toHaveLength(0);
	fireEvent.dragEnter(document.body, { dataTransfer: { types: ['text/plain'] } });
	expect(container.querySelectorAll('.is-file-dragging')).toHaveLength(0);
});
it('does not advance while server cancellation is pending', async () => {
	let confirm!: () => void;
	api.cancelDirectAssetUploadSession.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				confirm = resolve;
			}),
	);
	api.uploadDirectAssetFile.mockImplementation((_owner, _file, _kind, _progress, options) => {
		options.onSession({
			sessionId: 'active-session',
			owner: { type: 'PROJECT', id: 7 },
			kind: 'IMAGE',
			generation: 1,
		});
		return new Promise((_resolve, reject) =>
			options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
		);
	});
	setup();
	drop([file('a.jpg'), file('b.mp4')]);
	apply();
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce());
	fireEvent.click(screen.getAllByRole('button', { name: '취소' })[0]!);
	await waitFor(() => expect(api.cancelDirectAssetUploadSession).toHaveBeenCalledOnce());
	expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce();
	await act(async () => confirm());
	expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce();
	apply();
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(2));
});

it('does not repeat a completed upload after canonical refresh fails', async () => {
	let finishFirst!: (value: unknown) => void;
	api.uploadDirectAssetFile.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
	const { client } = setup();
	drop([file('first.png'), file('second.png')]);
	apply();
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce());
	const refresh = vi.spyOn(client, 'invalidateQueries').mockRejectedValue(new Error('offline'));
	await act(async () => finishFirst({ status: 'READY', sessionId: 'first' }));
	await waitFor(() => expect(screen.getByText('업로드 완료')).toBeTruthy());
	expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce();
	refresh.mockResolvedValue();
	apply();
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(2));
	expect(api.uploadDirectAssetFile.mock.calls[1]![1].name).toBe('second.png');
});

it('counts staged video removals before validating capacity', async () => {
	const full = { ...project, assets: Array.from({ length: 5 }, (_, index) => ({ ...project.assets[0]!, id: 11 + index, originalName: `stored-${index}.mp4` })) };
	const remove = vi.spyOn(adminAssetApi, 'remove').mockResolvedValue();
	setup(true, full);
	drop([file('replacement.mp4')]);
	apply();
	expect(api.uploadDirectAssetFile).not.toHaveBeenCalled();
	fireEvent.click(screen.getAllByRole('button', { name: '삭제' })[0]!);
	apply();
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce());
	expect(remove).toHaveBeenCalledExactlyOnceWith(11);
});
it('stages stored poster and WebGL deletion until Apply', async () => {
	const remove = vi.spyOn(adminAssetApi, 'remove').mockResolvedValue();
	const webgl = vi.spyOn(adminProjectApi, 'deleteWebgl').mockResolvedValue();
	setup(true, { ...project, posterAssetId: 11, webglDeployment: { id: 'old', url: '/play', createdAt: '2026-01-01' } });
	for (const button of screen.getAllByRole('button', { name: '삭제' })) fireEvent.click(button);
	expect(remove).not.toHaveBeenCalled();
	expect(webgl).not.toHaveBeenCalled();
	apply();
	await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe('false'));
	expect(remove).toHaveBeenCalledExactlyOnceWith(11);
	expect(webgl).toHaveBeenCalledExactlyOnceWith(7);
});
it('keeps Apply dirty for refresh when a failed widget completes through its own retry', async () => {
	api.uploadDirectAssetFile.mockRejectedValueOnce(new Error('실패')).mockResolvedValueOnce({ status: 'READY', sessionId: 'one' });
	const { client } = setup();
	drop([file('a.jpg')]);
	apply();
	fireEvent.click(await screen.findByRole('button', { name: '재시도' }));
	await screen.findByText('업로드 완료');
	expect(screen.getByTestId('dirty').textContent).toBe('true');
	const refresh = vi.spyOn(client, 'invalidateQueries');
	apply();
	await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe('false'));
	expect(refresh).toHaveBeenCalled();
	expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(2);
});

it.each(['complete', 'cancel', 'fail'] as const)('handles widget %s while Apply awaits a staged deletion', async (outcome) => {
	let finishUpload!: (value: unknown) => void;
	let failUpload!: (error: Error) => void;
	let finishDelete!: () => void;
	api.uploadDirectAssetFile.mockRejectedValueOnce(new Error('first failure'))
		.mockImplementationOnce((_owner, _file, _kind, _progress, options) => new Promise((resolve, reject) => {
			finishUpload = resolve; failUpload = reject;
			options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
		}));
	vi.spyOn(adminAssetApi, 'remove').mockImplementation(() => new Promise<void>((resolve) => { finishDelete = resolve; }));
	setup();
	drop([file('a.jpg'), file('remaining.mp4')]);
	apply();
	fireEvent.click(await screen.findByRole('button', { name: '재시도' }));
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(2));
	fireEvent.click(screen.getByRole('button', { name: '삭제' }));
	apply();
	await waitFor(() => expect(adminAssetApi.remove).toHaveBeenCalledOnce());
	if (outcome === 'complete') await act(async () => finishUpload({ status: 'READY', sessionId: 'manual' }));
	else if (outcome === 'fail') await act(async () => failUpload(new Error('second failure')));
	else {
			fireEvent.click(screen.getAllByRole('button', { name: '취소' })[0]!);
			await waitFor(() => expect(screen.queryByText('a.jpg')).toBeNull());
		}
	await act(async () => finishDelete());
	if (outcome === 'complete') {
		await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(3));
		expect(api.uploadDirectAssetFile.mock.calls[2]![1].name).toBe('remaining.mp4');
	} else {
		await waitFor(() => expect(screen.getByTestId('applying').textContent).toBe('false'));
		expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(2);
	}
});

it('binds student draft retries through the user submission endpoint', async () => {
  viewer.role = 'USER';
  const binding = { id: 'student-item', clientToken: 'b'.repeat(32) };
  const read = vi.spyOn(userProjectApi, 'getSubmission').mockResolvedValue({ submissionId: 'submission', projectId: 7, projectStatus: 'DRAFT', state: 'PENDING', items: [{ ...binding, kind: 'POSTER', slot: 'poster', required: true, state: 'FAILED' }] });
  const admin = vi.spyOn(adminProjectApi, 'getSubmission');
  api.uploadDirectAssetFile.mockResolvedValue({ status: 'READY', sessionId: 'student-retry' });
  setup(true, { ...project, status: 'DRAFT' }); drop([file('poster.png')], true); apply();
  await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce());
  expect(read).toHaveBeenCalledWith(7); expect(admin).not.toHaveBeenCalled(); expect(api.uploadDirectAssetFile.mock.calls[0]![4]).toMatchObject({ submissionItem: binding });
});
