/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdminProjectDetail } from '@pcu/contracts';
import {
	AdminProjectAssetManager,
	AdminProjectPosterUpload,
	AdminProjectUploadProvider,
} from '../features/admin/projects/AdminProjectAssetManager';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AdminProjectEditPage from '../pages/admin/AdminProjectEditPage';
import { adminProjectApi, publicApi } from '../lib/api';
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
vi.mock('../features/auth', () => ({ useMe: () => ({ user: { role: 'ADMIN' } }) }));
const project: AdminProjectDetail = {
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
function setup(enabled = true) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return {
		client,
		...render(
			<QueryClientProvider client={client}>
				<AdminProjectUploadProvider project={project} projectId={7} limits={limits} canEditContent={enabled}>
					<AdminProjectPosterUpload project={project} canEditContent={enabled} />
					<AdminProjectAssetManager canEditContent={enabled} />
				</AdminProjectUploadProvider>
			</QueryClientProvider>,
		),
	};
}
function drop(files: File[], poster = false) {
	fireEvent.drop(
		screen.getByRole('button', { name: poster ? '포스터 파일 선택' : '기타 파일 선택' }).parentElement!,
		{ dataTransfer: { files, types: ['Files'] } },
	);
}
const file = (name: string, type = '') => new File(['x'], name, { type });
beforeEach(() => {
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
it('removes existing assets and all asset manipulation controls; denies uploads without permission', () => {
	setup(false);
	expect(screen.queryByText('등록된 자산')).toBeNull();
	expect(screen.queryByText('existing.mp4')).toBeNull();
	for (const name of ['삭제', '메인으로 지정', '포스터로 지정', '위로', '아래로'])
		expect(screen.queryByRole('button', { name })).toBeNull();
	expect((screen.getByRole('button', { name: '기타 파일 선택' }) as HTMLButtonElement).disabled).toBe(true);
	drop([file('a.jpg')]);
	expect(api.uploadDirectAssetFile).not.toHaveBeenCalled();
});
it('rejects multiple posters and accepts PDF on the whole preview', async () => {
	setup();
	drop([file('a.jpg'), file('b.jpg')], true);
	expect(screen.getByRole('alert').textContent).toMatch(/한 개/);
	expect(api.uploadDirectAssetFile).not.toHaveBeenCalled();
	drop([file('a.pdf')], true);
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce());
	expect(api.uploadDirectAssetFile.mock.calls[0]![2]).toBe('POSTER');
});
it('runs mixed files sequentially, appends later drops, and skips unselected ZIPs', async () => {
	const resolvers: Array<(value: unknown) => void> = [];
	api.uploadDirectAssetFile.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
	setup();
	drop([file('game.zip'), file('a.jpg'), file('b.mp4')]);
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(1));
	expect(api.uploadDirectAssetFile.mock.calls[0]![1].name).toBe('a.jpg');
	drop([file('c.pdf')]);
	fireEvent.click(screen.getByRole('button', { name: '게임' }));
	expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(1);
	await act(async () => resolvers[0]!({ status: 'READY', sessionId: 'one' }));
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(2));
	expect(api.uploadDirectAssetFile.mock.calls[1]![1].name).toBe('game.zip');
	await act(async () => resolvers[1]!({ status: 'READY', sessionId: 'two' }));
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(3));
	expect(api.uploadDirectAssetFile.mock.calls[2]![1].name).toBe('b.mp4');
	await act(async () => resolvers[2]!({ status: 'READY', sessionId: 'three' }));
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(4));
	expect(api.uploadDirectAssetFile.mock.calls[3]![2]).toBe('DOCUMENT');
});
it('holds only materials on config failure and retries their settings', async () => {
	vi.mocked(publicApi.getUploadConfig).mockRejectedValueOnce(new Error('offline'));
	setup();
	drop([file('a.pdf'), file('b.mp4')]);
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce());
	expect(api.uploadDirectAssetFile.mock.calls[0]![2]).toBe('VIDEO');
	await waitFor(() =>
		expect((screen.getByRole('button', { name: '설정 재시도' }) as HTMLButtonElement).disabled).toBe(false),
	);
	fireEvent.click(screen.getByRole('button', { name: '설정 재시도' }));
	await waitFor(() => expect(publicApi.getUploadConfig).toHaveBeenCalledTimes(2));
	expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce();
});
it('keeps failed uploads in place for retry and advances only after cancel', async () => {
	api.uploadDirectAssetFile.mockRejectedValueOnce(new Error('전송 실패'));
	setup();
	drop([file('a.jpg'), file('b.mp4')]);
	await screen.findByRole('button', { name: '재시도' });
	expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce();
	fireEvent.click(screen.getAllByRole('button', { name: '취소' })[0]!);
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(2));
	expect(api.uploadDirectAssetFile.mock.calls[1]![1].name).toBe('b.mp4');
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
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce());
	fireEvent.click(screen.getAllByRole('button', { name: '취소' })[0]!);
	await waitFor(() => expect(api.cancelDirectAssetUploadSession).toHaveBeenCalledOnce());
	expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce();
	await act(async () => confirm());
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(2));
});

it('keeps pending files mounted when completion refresh fails, then continues after retry', async () => {
	let failDetail = false;
	vi.spyOn(adminProjectApi, 'getDetail').mockImplementation(async () => {
		if (failDetail) throw new Error('detail unavailable');
		return project;
	});
	let finishFirst!: (value: unknown) => void;
	api.uploadDirectAssetFile.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finishFirst = resolve;
			}),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={['/admin/projects/7/edit']}>
				<Routes>
					<Route path="/admin/projects/:id/edit" element={<AdminProjectEditPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	await screen.findByRole('button', { name: '기타 파일 선택' });
	drop([file('first.png'), file('second.png')]);
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce());
	failDetail = true;
	await act(async () => finishFirst({ status: 'READY', sessionId: 'first' }));
	await screen.findByRole('button', { name: '조회 재시도' });
	expect(screen.getByText('second.png')).toBeTruthy();
	expect(api.uploadDirectAssetFile).toHaveBeenCalledOnce();
	failDetail = false;
	fireEvent.click(screen.getByRole('button', { name: '조회 재시도' }));
	await waitFor(() => expect(api.uploadDirectAssetFile).toHaveBeenCalledTimes(2));
	expect(api.uploadDirectAssetFile.mock.calls[1]![1].name).toBe('second.png');
});
