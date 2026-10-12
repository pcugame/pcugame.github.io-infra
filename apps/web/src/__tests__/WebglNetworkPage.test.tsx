/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api/client';
import type { WebglNetworkRequest } from '@pcu/contracts';
import WebglNetworkPage from '../pages/WebglNetworkPage';
vi.mock('../features/auth', () => ({ useMe: () => ({ user: { id: 1 }, isPending: false }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const item: WebglNetworkRequest = { id: 'request-1', projectId: 7, originalProjectId: 7, projectTitle: '<img src=x onerror=alert(1)>', requesterId: 1, origin: 'https://assets.example.com', purpose: 'Remote bundles', mode: 'HTTPS', cors: 'Allow NAS origin', state: 'PENDING', reviewerId: null, reviewReason: null, createdAt: '2026-10-01T00:00:00.000Z', reviewedAt: null, revokedAt: null, policyVersion: null, events: [] };
const form = () => within(document.getElementById('network-new-request')!);
function mount(admin = false) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/me/projects/7/network']}><Routes><Route path="/me/projects/:id/network" element={<WebglNetworkPage admin={admin} />} /></Routes></MemoryRouter></QueryClientProvider>);
}
describe('WebGL external connection workflow', () => {
	it('submits an exact host with all ports, purpose and remote CORS plan', async () => {
		vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
		const post = vi.spyOn(api, 'post').mockResolvedValue(item);
		mount();
		await screen.findByText('등록된 신청이 없습니다.');
		fireEvent.change(form().getByLabelText('호스트명'), { target: { value: 'assets.example.com' } });
		fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: 'Remote bundles' } });
		fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'Allow NAS origin' } });
		fireEvent.click(screen.getByRole('button', { name: '검토 신청' }));
		await waitFor(() => expect(post).toHaveBeenCalledWith('/api/me/projects/7/webgl-network-requests', { origin: 'https://assets.example.com:*', mode: 'HTTPS', purpose: 'Remote bundles', cors: 'Allow NAS origin' }));
		expect(screen.getAllByText('https://nas.example.com').length).toBeGreaterThan(0);
	});

 it.each([['8443', ':8443'], ['443', ''], ['65535', ':65535']])('serializes subdomain scope with specific port %s', async (port, suffix) => {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  const post = vi.spyOn(api, 'post').mockResolvedValue(item);
  mount(); await screen.findByText('등록된 신청이 없습니다.');
  fireEvent.change(form().getByLabelText('포트 정책'), { target: { value: 'specific' } });
  fireEvent.change(form().getByLabelText('특정 포트'), { target: { value: port } });
  fireEvent.change(form().getByLabelText('호스트 범위'), { target: { value: 'subdomains' } });
  fireEvent.change(form().getByLabelText('호스트명'), { target: { value: 'example.com' } });
  fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: 'Bundles' } });
  fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'CORS enabled' } });
  fireEvent.click(screen.getByRole('button', { name: '검토 신청' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/api/me/projects/7/webgl-network-requests', expect.objectContaining({ origin: `https://*.example.com${suffix}` })));
 });
 it('retries only failed profile requests after partial success', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  const post = vi.spyOn(api, 'post').mockResolvedValueOnce(item).mockRejectedValueOnce(new Error('Temporary failure')).mockResolvedValue(item);
  mount(); await screen.findByText('등록된 신청이 없습니다.');
  fireEvent.change(screen.getByLabelText('서비스'), { target: { value: 'relay' } });
  fireEvent.click(screen.getByLabelText('예시 1 선택')); fireEvent.click(screen.getByLabelText('예시 2 선택'));
  fireEvent.change(screen.getByLabelText('예시 사용 목적'), { target: { value: 'Multiplayer' } });
  fireEvent.change(screen.getByLabelText('예시 서버 설정 계획'), { target: { value: 'Origin and account configured' } });
  const button = screen.getByRole('button', { name: '선택한 예시 신청 / 실패 항목 재시도' });
  fireEvent.click(button);
  await screen.findByText('이미 등록됨 · 재신청하지 않습니다.');
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
  expect(post.mock.calls.map(call => (call[1] as { origin: string }).origin)).toEqual(['https://authentication.example.com:*', 'https://allocation.example.com:*', 'https://allocation.example.com:*']);
 });
 it.each(['example.com:8443', 'example.com:443', 'https://example.com:8443', 'example.com/path', '*.example.com', 'localhost'])('rejects host input %s without discarding its port or scope', async host => {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  const post = vi.spyOn(api, 'post');
  mount(); await screen.findByText('등록된 신청이 없습니다.');
  fireEvent.change(form().getByLabelText('호스트명'), { target: { value: host } });
  fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: 'Bundles' } });
  fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'CORS enabled' } });
  fireEvent.click(screen.getByRole('button', { name: '검토 신청' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect((form().getByLabelText('호스트명') as HTMLInputElement).value).toBe(host);
  expect(post).not.toHaveBeenCalled();
 });
 it('submits subdomains with all ports without adding the root', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  const post = vi.spyOn(api, 'post').mockResolvedValue(item);
  mount(); await screen.findByText('등록된 신청이 없습니다.');
  fireEvent.change(form().getByLabelText('호스트명'), { target: { value: 'example.com' } });
  fireEvent.change(form().getByLabelText('호스트 범위'), { target: { value: 'subdomains' } });
  fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: 'Bundles' } });
  fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'CORS enabled' } });
  fireEvent.click(screen.getByRole('button', { name: '검토 신청' }));
  await waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith('/api/me/projects/7/webgl-network-requests', expect.objectContaining({ origin: 'https://*.example.com:*' })));
 });
 it('offers one Photon rule and preserves an edited numeric port in advanced settings', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  const post = vi.spyOn(api, 'post').mockResolvedValue(item);
  mount(); await screen.findByText('등록된 신청이 없습니다.');
  const profile = within(screen.getByRole('region', { name: '서비스별 신청 예시' }));
  expect(profile.getAllByRole('checkbox')).toHaveLength(1);
  fireEvent.click(profile.getByLabelText('예시 1 선택'));
  fireEvent.change(profile.getByLabelText('호스트명'), { target: { value: 'game.example.com:19090' } });
  fireEvent.change(profile.getByLabelText('예시 사용 목적'), { target: { value: 'Multiplayer' } });
  fireEvent.change(profile.getByLabelText('예시 서버 설정 계획'), { target: { value: 'Origin configured' } });
  fireEvent.click(profile.getByRole('button'));
  await profile.findByText(/숫자 포트는 고급 설정에/);
  expect(post).not.toHaveBeenCalled();
  fireEvent.change(profile.getByLabelText('호스트명'), { target: { value: 'game.example.com' } });
  fireEvent.change(profile.getByLabelText('호스트 범위'), { target: { value: 'exact' } });
  fireEvent.change(profile.getByLabelText('포트 정책'), { target: { value: 'specific' } });
  fireEvent.change(profile.getByLabelText('특정 포트'), { target: { value: '19090' } });
  fireEvent.click(profile.getByRole('button'));
  await waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith('/api/me/projects/7/webgl-network-requests', expect.objectContaining({ origin: 'wss://game.example.com:19090' })));
 });
 it('shows actual all-port and legacy port scopes to reviewers without converting records', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [item, { ...item, id: 'all', origin: 'wss://*.example.com:*', mode: 'WSS' }, { ...item, id: 'numeric', origin: 'https://other.example.com:8443' }], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  mount(true); await screen.findByText(item.origin);
  expect(screen.getByText('HTTPS · assets.example.com · 특정 포트 443 (기본 포트)')).toBeTruthy();
  expect(screen.getByText('WSS · example.com의 하위 도메인만 (루트 제외) · 모든 포트 (1~65535)')).toBeTruthy();
  expect(screen.getByText('HTTPS · other.example.com · 특정 포트 8443')).toBeTruthy();
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
		expect(form().getByRole('textbox', { name: '호스트명' }).getAttribute('placeholder')).toBe('assets.example.com');
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
		await screen.findByText('등록된 신청이 없습니다.');
		fireEvent.change(form().getByLabelText('연결 방식'), { target: { value: 'WSS' } });
		expect(screen.getByText(/서버의 Origin 검사 시 확인할 게임 origin/)).toBeTruthy();
		fireEvent.change(form().getByLabelText('호스트명'), { target: { value: 'socket.example.com' } });
		fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: '실시간 연결' } });
		fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'Origin 검사와 인증 토큰' } });
		fireEvent.click(screen.getByRole('button', { name: '검토 신청' }));
		await waitFor(() => expect(post).toHaveBeenCalledWith('/api/me/projects/7/webgl-network-requests', { origin: 'wss://socket.example.com:*', mode: 'WSS', purpose: '실시간 연결', cors: 'Origin 검사와 인증 토큰' }));
	});

 it('previews a pasted explicit 443 and submits only after matching the port setting', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  const post = vi.spyOn(api, 'post').mockResolvedValue(item);
  mount(); await screen.findByText('등록된 신청이 없습니다.');
  fireEvent.change(form().getByLabelText('호스트명'), { target: { value: 'https://ASSETS.example.com:443/' } });
  fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: 'Bundles' } });
  fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'CORS enabled' } });
  fireEvent.click(screen.getByRole('button', { name: '검토 신청' }));
  expect(post).not.toHaveBeenCalled();
  fireEvent.change(form().getByLabelText('포트 정책'), { target: { value: 'specific' } });
  expect(form().getByText('https://assets.example.com')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '검토 신청' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ origin: 'https://assets.example.com' })));
 });
 it.each([false, true])('shows overlapping approvals across filters but only for the same project (admin=%s)', async admin => {
  const approved = { ...item, id: 'old-443', state: 'APPROVED' };
  vi.spyOn(api, 'get').mockResolvedValue({ items: [approved, { ...approved, id: 'other-project', projectId: 8 }, { ...item, id: 'new-all', origin: 'https://assets.example.com:*' }], gameOrigin: 'https://nas.example.com', policyVersion: 1 });
  mount(admin); await screen.findByText('HTTPS · assets.example.com · 모든 포트 (1~65535)');
  expect(screen.getByText(/신청 #old-443/)).toBeTruthy();
  expect(screen.queryByText(/신청 #other-project/)).toBeNull();
  expect(screen.getByText(/새 승인 → 새 실행/)).toBeTruthy();
 });

});
