/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminProjectDetail, ProjectVideo } from '@pcu/contracts';
import { useVideoConversionRetry } from '../features/admin/projects/useVideoConversionRetry';
import { VideoFileRow } from '../features/admin/projects/VideoFileRow';
import { adminProjectApi } from '../lib/api';
import { queryKeys } from '../lib/query';

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); });
function mount(disabled = false, status: 'FAILED' | 'PENDING' | 'READY' = 'FAILED', options: {material?: boolean; canRetry?: boolean; removing?: boolean; video?: Partial<ProjectVideo>} = {}) {
	const project = { id: 213, assets: [{ id: 769, originalName: 'QuickService.mp4' }], videos: [{ assetId: 769, playbackStatus: status, playbackError: 'Generated playback is not browser-safe', ...options.video }] } as AdminProjectDetail;
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(queryKeys.adminProject(213), project);
	function Panel() {
		const query = useQuery({ queryKey: queryKeys.adminProject(213), queryFn: () => adminProjectApi.getDetail(213), staleTime: Infinity });
		const conversion = useVideoConversionRetry(213, disabled);
        return <ul><VideoFileRow material={options.material} name="QuickService.mp4" assetId={769} video={query.data!.videos[0]} conversion={conversion} canRetry={options.canRetry ?? true} canDelete deleteDisabled={conversion.busy !== null} removing={options.removing ?? false} onDelete={() => {}} /></ul>;
	}
	render(<QueryClientProvider client={client}><Panel /></QueryClientProvider>);
}
describe('administrator video conversion retry', () => {
	it('queues one retry and updates the displayed failed video to pending', async () => {
		const post = vi.spyOn(adminProjectApi, 'retryVideo').mockResolvedValue({ assetId: 769, playbackStatus: 'PENDING' });
		vi.spyOn(adminProjectApi, 'getDetail').mockRejectedValue(new Error('Temporary read failure'));
		mount();
		const button = screen.getByRole('button', { name: /영상 변환 다시 시도/ });
		fireEvent.click(button); fireEvent.click(button);
		await screen.findByText('변환 대기');
		expect(post).toHaveBeenCalledExactlyOnceWith(213, 769);
		expect(screen.queryByRole('button', { name: /영상 변환 다시 시도/ })).toBeNull();
	});
	it('keeps a failed retry actionable and reports the server error', async () => {
		vi.spyOn(adminProjectApi, 'retryVideo').mockRejectedValue(new Error('영상 원본을 다시 업로드해 주세요.'));
		vi.spyOn(adminProjectApi, 'getDetail').mockRejectedValue(new Error('Temporary read failure'));
		mount(); fireEvent.click(screen.getByRole('button', { name: /영상 변환 다시 시도/ }));
		expect((await screen.findByRole('alert')).textContent).toContain('원본을 다시 업로드');
	});
	it('disables retry while editor changes are pending', () => {
		mount(true);
		expect((screen.getByRole('button', { name: /영상 변환 다시 시도/ }) as HTMLButtonElement).disabled).toBe(true);
	});
	it('does not offer retry for PENDING videos', () => {
        const status = 'PENDING';
		mount(false, status);
		expect(screen.queryByRole('button', { name: /영상 변환 다시 시도/ })).toBeNull();
	});
 it('offers regeneration for READY legacy videos', () => { mount(false, 'READY'); expect(screen.getByRole('button', { name: /영상 변환 다시 시도/ })).toBeTruthy(); });
 it('shows running state without stale failure or another retry', () => {
  mount(false, 'FAILED', {video: {playbackJob: {id: 'job', status: 'RUNNING'}}});
  expect(screen.getByRole('status').textContent).toBe('변환 중');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', {name: /영상 변환 다시 시도/})).toBeNull();
 });
 it('shows status without exposing administrator retry to other viewers', () => {
  mount(false, 'FAILED', {canRetry: false});
  expect(screen.getByRole('status').textContent).toBe('변환 실패');
  expect(screen.queryByRole('button', {name: /영상 변환 다시 시도/})).toBeNull();
 });
 it('disables regeneration for an asset marked for deletion', () => {
  mount(false, 'READY', {removing: true});
  expect((screen.getByRole('button', {name: /영상 변환 다시 시도/}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', {name: '삭제 취소'})).toBeTruthy();
 });

});

it('shows failed conversion retry inline and keeps successful regeneration in the material menu', () => {
 const retry = vi.spyOn(adminProjectApi, 'retryVideo').mockImplementation(() => new Promise(() => {}));
 mount(false, 'FAILED', { material: true });
 expect(screen.getByRole('button', { name: /영상 변환 다시 시도/ }).textContent).toBe('재시도');
 expect(screen.getByText('실패 이유 · 파일 정보')).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: /영상 변환 다시 시도/ }));
 expect(retry).toHaveBeenCalledOnce();
 cleanup();
 mount(false, 'READY', { material: true });
 expect(screen.queryByRole('button', { name: /영상 변환 다시 시도/ })).toBeNull();
 fireEvent.click(screen.getByRole('button', { name: 'QuickService.mp4 더보기' }));
 expect(screen.getByRole('menuitem', { name: '영상 다시 변환' })).toBeTruthy();
});
