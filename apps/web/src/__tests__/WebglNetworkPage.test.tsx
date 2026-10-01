/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api/client';
import type { WebglNetworkRequest } from '@pcu/contracts';
import WebglNetworkPage from '../pages/WebglNetworkPage';
vi.mock('../features/auth', () => ({ useMe: () => ({ user: { id: 1 }, isPending: false }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const item: WebglNetworkRequest = { id: 'request-1', projectId: 7, originalProjectId: 7, projectTitle: '<img src=x onerror=alert(1)>', requesterId: 1, origin: 'https://assets.example.com', purpose: 'Remote bundles', mode: 'HTTPS', cors: 'Allow NAS origin', state: 'PENDING', reviewerId: null, reviewReason: null, createdAt: '2026-10-01T00:00:00.000Z', reviewedAt: null, revokedAt: null, policyVersion: null, events: [] };
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
		expect(screen.getAllByText('https://nas.example.com').length).toBeGreaterThan(0);
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
	it('explains the owner and administrator steps with the next launch timing', async () => {
		vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
		mount();
		await screen.findByRole('heading', { name: '연결 주소 신청' });
		expect(screen.getByText(/내 작품 → 외부 연결/)).toBeTruthy();
		expect(screen.getByText(/관리 메뉴 → 게임 외부 연결/)).toBeTruthy();
		expect(screen.getByRole('heading', { name: '다음 게임 실행에 적용' })).toBeTruthy();
		expect(screen.getByText('작품 참여자 신청 화면')).toBeTruthy();
		expect(screen.getByRole('link', { name: '새 연결 신청' }).getAttribute('href')).toBe('#network-new-request');
		expect(document.getElementById('network-new-request')?.tagName).toBe('FORM');
		expect(screen.getByRole('textbox', { name: '정확한 origin' }).getAttribute('type')).toBe('url');
	});
	it('defaults administrator to pending review and filters with counts', async () => {
		vi.spyOn(api, 'get').mockResolvedValue({ items: [item, { ...item, id: 'approved-1', origin: 'https://approved.example.com', state: 'APPROVED' }], gameOrigin: 'https://nas.example.com', policyVersion: null });
		mount(true);
		await screen.findByRole('button', { name: '승인' });
		expect(screen.getByText('관리자 검토 화면')).toBeTruthy();
		expect(screen.queryByText('https://approved.example.com')).toBeNull();
		expect(screen.queryByRole('button', { name: '검토 신청' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: '승인 1' }));
		expect(screen.getByText('https://approved.example.com')).toBeTruthy();
		expect(screen.queryByRole('button', { name: '승인' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: '반려 0' }));
		expect(screen.getByRole('heading', { name: '반려 신청이 없습니다.' })).toBeTruthy();
	});
	it.each([
		['PENDING', '반려', 'reject'],
		['APPROVED', '승인 철회', 'revoke'],
	] as const)('requires and submits a trimmed reason for %s action', async (state, button, action) => {
		vi.spyOn(api, 'get').mockResolvedValue({ items: [{ ...item, state }], gameOrigin: 'https://nas.example.com', policyVersion: 1 });
		const post = vi.spyOn(api, 'post').mockResolvedValue(item);
		mount(true);
		await screen.findByText('관리자 검토 화면');
		if (state === 'APPROVED') fireEvent.click(screen.getByRole('button', { name: '승인 1' }));
		const control = screen.getByRole('button', { name: button });
		expect((control as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(screen.getByLabelText('검토 사유'), { target: { value: '   ' } });
		expect((control as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(screen.getByLabelText('검토 사유'), { target: { value: '  설정 보완 필요  ' } });
		fireEvent.click(control);
		await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/admin/webgl-network-requests/request-1/${action}`, { reason: '설정 보완 필요' }));
	});
	it('shows collapsed Korean history and preserves escaped reasons', async () => {
		vi.spyOn(api, 'get').mockResolvedValue({ items: [{ ...item, state: 'REVOKED', events: [{ id: 'event-1', action: 'REVOKE', actorId: 2, reason: '<script>unsafe()</script>', policyVersion: 1, createdAt: item.createdAt }] }], gameOrigin: 'https://nas.example.com', policyVersion: 1 });
		mount();
		const summary = await screen.findByText(/처리 이력/);
		const history = summary.closest('details')!;
		expect(history.open).toBe(false);
		fireEvent.click(summary);
		expect(history.open).toBe(true);
		expect(screen.getByText('승인 철회')).toBeTruthy();
		expect(screen.getByText('<script>unsafe()</script>')).toBeTruthy();
		expect(document.querySelector('script')).toBeNull();
	});
	it('keeps deleted projects as records without review controls', async () => {
		vi.spyOn(api, 'get').mockResolvedValue({ items: [{ ...item, projectId: null }], gameOrigin: 'https://nas.example.com', policyVersion: null });
		mount(true);
		await screen.findByText(/삭제된 작품의 기록/);
		expect(screen.queryByLabelText('검토 사유')).toBeNull();
		expect(screen.queryByRole('button', { name: '승인' })).toBeNull();
	});
	it('returns an unavailable administrator to project management', async () => {
		vi.spyOn(api, 'get').mockRejectedValue(new ApiError(404, 'Not Found', {}));
		mount(true);
		const link = await screen.findByRole('link', { name: '작품 관리로 돌아가기' });
		expect(link.getAttribute('href')).toBe('/admin/projects');
	});

	it('submits WSS requests and explains server Origin inspection', async () => {
		vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
		const post = vi.spyOn(api, 'post').mockResolvedValue(item);
		mount();
		await screen.findByLabelText('연결 방식');
		fireEvent.change(screen.getByLabelText('연결 방식'), { target: { value: 'WSS' } });
		expect(screen.getByText(/서버의 Origin 검사 시 확인할 게임 origin/)).toBeTruthy();
		fireEvent.change(screen.getByLabelText('정확한 origin'), { target: { value: 'wss://socket.example.com' } });
		fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: '실시간 연결' } });
		fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'Origin 검사와 인증 토큰' } });
		fireEvent.click(screen.getByRole('button', { name: '검토 신청' }));
		await waitFor(() => expect(post).toHaveBeenCalledWith('/api/me/projects/7/webgl-network-requests', { origin: 'wss://socket.example.com', mode: 'WSS', purpose: '실시간 연결', cors: 'Origin 검사와 인증 토큰' }));
	});

});
