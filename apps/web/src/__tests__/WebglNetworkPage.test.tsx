/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api/client';
import WebglNetworkPage from '../pages/WebglNetworkPage';
vi.mock('../features/auth', () => ({ useMe: () => ({ user: { id: 1 }, isPending: false }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const item = { id: 'request-1', projectId: 7, originalProjectId: 7, projectTitle: '<img src=x onerror=alert(1)>', requesterId: 1, origin: 'https://assets.example.com', purpose: 'Remote bundles', mode: 'HTTPS', cors: 'Allow NAS origin', state: 'PENDING', reviewerId: null, reviewReason: null, createdAt: '2026-10-01T00:00:00.000Z', reviewedAt: null, revokedAt: null, policyVersion: null, events: [] };
function mount(admin = false) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/me/projects/7/network']}><Routes><Route path="/me/projects/:id/network" element={<WebglNetworkPage admin={admin} />} /></Routes></MemoryRouter></QueryClientProvider>);
}
describe('WebGL external connection workflow', () => {
	it('submits exact origin with purpose and remote CORS plan', async () => {
		vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
		const post = vi.spyOn(api, 'post').mockResolvedValue(item);
		mount();
		await screen.findByText('등록된 신청이 없습니다.');
		fireEvent.change(screen.getByLabelText('정확한 origin'), { target: { value: 'https://assets.example.com' } });
		fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: 'Remote bundles' } });
		fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'Allow NAS origin' } });
		fireEvent.click(screen.getByRole('button', { name: '검토 신청' }));
		await waitFor(() => expect(post).toHaveBeenCalledWith('/api/me/projects/7/webgl-network-requests', { origin: 'https://assets.example.com', mode: 'HTTPS', purpose: 'Remote bundles', cors: 'Allow NAS origin' }));
		expect(screen.getByText('https://nas.example.com')).toBeTruthy();
	});
	it('requires a review reason and escapes project strings', async () => {
		vi.spyOn(api, 'get').mockResolvedValue({ items: [item], gameOrigin: 'https://nas.example.com', policyVersion: null });
		const post = vi.spyOn(api, 'post').mockResolvedValue(item);
		mount(true);
		const approve = await screen.findByRole('button', { name: '승인' });
		expect((approve as HTMLButtonElement).disabled).toBe(true);
		expect(document.querySelector('img')).toBeNull();
		fireEvent.change(screen.getByLabelText('검토 사유'), { target: { value: 'Service and CORS reviewed' } });
		fireEvent.click(approve);
		await waitFor(() => expect(post).toHaveBeenCalledWith('/api/admin/webgl-network-requests/request-1/approve', { reason: 'Service and CORS reviewed' }));
	});
	it('hides submission controls when the feature is unavailable', async () => {
		vi.spyOn(api, 'get').mockRejectedValue(new ApiError(404, 'Not Found', {}));
		mount();
		await screen.findByText(/아직 활성화되지/);
		expect(screen.queryByRole('button', { name: '검토 신청' })).toBeNull();
	});
});
