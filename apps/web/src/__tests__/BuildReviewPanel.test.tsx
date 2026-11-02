/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuildReview } from '@pcu/contracts';
import { BuildReviewPanel } from '../features/admin/build-reviews/BuildReviewPanel';
import { api } from '../lib/api/client';

const review: BuildReview = {
	id: 'review-1',
	sessionId: 'upload-1',
	projectId: 7,
	generation: 1,
	sourceIdentity: 'a'.repeat(64),
	validatorVersion: 'build-package-v1',
	kind: 'WEBGL',
	originalName: 'game.zip',
	totalBytes: 1024,
	decision: 'PENDING',
	version: 1,
	decidedBy: null,
	reason: null,
	entryPath: null,
	createdAt: '2026-10-16T00:00:00Z',
	decidedAt: null,
	inspection: {
		version: 'build-package-v1',
		outcome: 'REVIEW',
		engines: [],
		evidence: [],
		reasons: ['ambiguous-web-entry'],
		entryCandidates: ['a.html', 'b.html'],
		entryPath: null,
		files: [{ path: '<script>alert(1)</script>.html', bytes: 10 }],
	},
};
let client: QueryClient;
afterEach(() => {
	cleanup();
	client?.clear();
	vi.restoreAllMocks();
});
function mount() {
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<BuildReviewPanel projectId={7} />
		</QueryClientProvider>,
	);
}
describe('common build review panel', () => {
	it('requires a reason and analyzed entry, submits the displayed version and never executes uploaded HTML', async () => {
		vi.spyOn(api, 'get').mockImplementation(async (path) => (path.endsWith('/review-1') ? review : [review]));
		const post = vi.spyOn(api, 'post').mockResolvedValue({});
		mount();
		fireEvent.click(await screen.findByText(/game.zip/));
		expect(document.querySelector('iframe,script')).toBeNull();
		const approve = (await screen.findByRole('button', { name: '허용' })) as HTMLButtonElement;
		expect(approve.disabled).toBe(true);
		fireEvent.change(await screen.findByLabelText('검토 사유'), { target: { value: '실행 진입점 확인' } });
		expect(approve.disabled).toBe(true);
		fireEvent.change(screen.getByLabelText('실행 HTML'), { target: { value: 'b.html' } });
		fireEvent.click(approve);
		await waitFor(() =>
			expect(post).toHaveBeenCalledWith('/api/admin/build-reviews/review-1/decision', {
				decision: 'APPROVED',
				version: 1,
				reason: '실행 진입점 확인',
				entryPath: 'b.html',
			}),
		);
	});
	it('allows rejection without selecting an entry and reports a stale decision', async () => {
		vi.spyOn(api, 'get').mockImplementation(async (path) => (path.endsWith('/review-1') ? review : [review]));
		const post = vi.spyOn(api, 'post').mockRejectedValue(new Error('Review version changed'));
		mount();
		fireEvent.click(await screen.findByText(/game.zip/));
		fireEvent.change(await screen.findByLabelText('검토 사유'), { target: { value: '실행 구조 누락' } });
		fireEvent.click(screen.getByRole('button', { name: '거절' }));
		await screen.findByRole('alert');
		expect(post).toHaveBeenCalledWith('/api/admin/build-reviews/review-1/decision', {
			decision: 'REJECTED',
			version: 1,
			reason: '실행 구조 누락',
		});
	});
	it('shows an empty queue', async () => {
		vi.spyOn(api, 'get').mockResolvedValue([]);
		mount();
		await screen.findByText('검토 대기 중인 빌드가 없습니다.');
	});
});
