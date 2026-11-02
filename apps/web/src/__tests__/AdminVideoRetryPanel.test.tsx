/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminProjectDetail } from '@pcu/contracts';
import { AdminVideoRetryPanel } from '../features/admin/projects/AdminVideoRetryPanel';
import { adminProjectApi } from '../lib/api';
import { queryKeys } from '../lib/query';

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); vi.restoreAllMocks(); });
function mount(disabled = false, status: 'FAILED' | 'PENDING' | 'READY' = 'FAILED') {
	const project = { id: 213, assets: [{ id: 769, originalName: 'QuickService.mp4' }], videos: [{ assetId: 769, playbackStatus: status, playbackError: 'Generated playback is not browser-safe' }] } as AdminProjectDetail;
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(queryKeys.adminProject(213), project);
	function Panel() {
		const query = useQuery({ queryKey: queryKeys.adminProject(213), queryFn: () => adminProjectApi.getDetail(213), staleTime: Infinity });
		return <AdminVideoRetryPanel project={query.data!} disabled={disabled} />;
	}
	render(<QueryClientProvider client={client}><Panel /></QueryClientProvider>);
}
describe('administrator video conversion retry', () => {
	it('queues one retry and updates the displayed failed video to pending', async () => {
		const post = vi.spyOn(adminProjectApi, 'retryVideo').mockResolvedValue({ assetId: 769, playbackStatus: 'PENDING' });
		vi.spyOn(adminProjectApi, 'getDetail').mockRejectedValue(new Error('Temporary read failure'));
		mount();
		const button = screen.getByRole('button', { name: '영상 변환 다시 시도' });
		fireEvent.click(button); fireEvent.click(button);
		await screen.findByText(/재생본 작업: PENDING/);
		expect(post).toHaveBeenCalledExactlyOnceWith(213, 769);
		expect(screen.queryByRole('button', { name: '영상 변환 다시 시도' })).toBeNull();
	});
	it('keeps a failed retry actionable and reports the server error', async () => {
		vi.spyOn(adminProjectApi, 'retryVideo').mockRejectedValue(new Error('영상 원본을 다시 업로드해 주세요.'));
		vi.spyOn(adminProjectApi, 'getDetail').mockRejectedValue(new Error('Temporary read failure'));
		mount(); fireEvent.click(screen.getByRole('button', { name: '영상 변환 다시 시도' }));
		expect((await screen.findByRole('alert')).textContent).toContain('원본을 다시 업로드');
	});
	it('disables retry while editor changes are pending', () => {
		mount(true);
		expect((screen.getByRole('button', { name: '영상 변환 다시 시도' }) as HTMLButtonElement).disabled).toBe(true);
	});
	it('does not offer retry for PENDING videos', () => {
        const status = 'PENDING';
		mount(false, status);
		expect(screen.queryByRole('button')).toBeNull();
	});
 it('offers regeneration for READY legacy videos', () => { mount(false, 'READY'); expect(screen.getByRole('button')).toBeTruthy(); });
});
