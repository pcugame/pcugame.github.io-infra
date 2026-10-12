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
		fireEvent.change(form().getByLabelText('도메인 (호스트명)'), { target: { value: 'assets.example.com' } });
		fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: 'Remote bundles' } });
		fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'Allow NAS origin' } });
		fireEvent.click(screen.getByRole('button', { name: '연결 1개 신청' }));
		await waitFor(() => expect(post).toHaveBeenCalledWith('/api/me/projects/7/webgl-network-requests/batch', { items: [{ origin: 'https://assets.example.com:*', mode: 'HTTPS', purpose: 'Remote bundles', cors: 'Allow NAS origin' }] }));
		expect(screen.getAllByText('https://nas.example.com').length).toBeGreaterThan(0);
	});

 it.each([['8443', ':8443'], ['443', ''], ['65535', ':65535']])('serializes subdomain scope with specific port %s', async (port, suffix) => {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  const post = vi.spyOn(api, 'post').mockResolvedValue(item);
  mount(); await screen.findByText('등록된 신청이 없습니다.');
  fireEvent.change(form().getByLabelText('포트 정책'), { target: { value: 'specific' } });
  fireEvent.change(form().getByLabelText('특정 포트'), { target: { value: port } });
  fireEvent.change(form().getByLabelText('호스트 범위'), { target: { value: 'subdomains' } });
  fireEvent.change(form().getByLabelText('도메인 (호스트명)'), { target: { value: 'example.com' } });
  fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: 'Bundles' } });
  fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'CORS enabled' } });
  fireEvent.click(screen.getByRole('button', { name: '연결 1개 신청' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith('/api/me/projects/7/webgl-network-requests/batch', { items: [expect.objectContaining({ origin: `https://*.example.com${suffix}` })] }));
 });
 it.each(['example.com:8443', 'example.com:443', 'https://example.com:8443', 'example.com/path', '*.example.com', 'localhost'])('rejects host input %s without discarding its port or scope', async host => {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  const post = vi.spyOn(api, 'post');
  mount(); await screen.findByText('등록된 신청이 없습니다.');
  fireEvent.change(form().getByLabelText('도메인 (호스트명)'), { target: { value: host } });
  fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: 'Bundles' } });
  fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'CORS enabled' } });
  fireEvent.click(screen.getByRole('button', { name: '연결 1개 신청' }));
  expect(await screen.findAllByRole('alert')).toBeTruthy();
  expect((form().getByLabelText('도메인 (호스트명)') as HTMLInputElement).value).toBe(host);
  expect(post).not.toHaveBeenCalled();
 });
 it.each(['0', '65536', '443abc'])('associates invalid port %s with its field and prevents submission', async port => {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  const post = vi.spyOn(api, 'post');
  mount(); await screen.findByText('등록된 신청이 없습니다.');
  expect(form().queryByLabelText('특정 포트')).toBeNull();
  fireEvent.change(form().getByLabelText('도메인 (호스트명)'), { target: { value: 'example.com' } });
  fireEvent.change(form().getByLabelText('포트 정책'), { target: { value: 'specific' } });
  fireEvent.change(form().getByLabelText('특정 포트'), { target: { value: port } });
  expect(form().getByLabelText('특정 포트').getAttribute('aria-invalid')).toBe('true');
  expect(form().queryByLabelText('신청 미리보기')).toBeNull();
  fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: 'Bundles' } });
  fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'CORS enabled' } });
  fireEvent.click(screen.getByRole('button', { name: '연결 1개 신청' }));
  expect(post).not.toHaveBeenCalled();
  expect((form().getByLabelText('특정 포트') as HTMLInputElement).value).toBe(port);
 });
 it('submits subdomains with all ports without adding the root', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  const post = vi.spyOn(api, 'post').mockResolvedValue(item);
  mount(); await screen.findByText('등록된 신청이 없습니다.');
  fireEvent.change(form().getByLabelText('도메인 (호스트명)'), { target: { value: 'example.com' } });
  fireEvent.change(form().getByLabelText('호스트 범위'), { target: { value: 'subdomains' } });
  fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: 'Bundles' } });
  fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'CORS enabled' } });
  fireEvent.click(screen.getByRole('button', { name: '연결 1개 신청' }));
  await waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith('/api/me/projects/7/webgl-network-requests/batch', { items: [expect.objectContaining({ origin: 'https://*.example.com:*' })] }));
 });
 it('uses the same strict host and numeric port fields for Photon', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  const post = vi.spyOn(api, 'post').mockResolvedValue(item);
  mount(); await screen.findByText('등록된 신청이 없습니다.');
  const profile = within(screen.getByRole('region', { name: '서비스별 신청 예시' }));
  expect(profile.getAllByRole('checkbox')).toHaveLength(1);
  fireEvent.click(profile.getByLabelText('예시 1 선택'));
  fireEvent.change(profile.getByLabelText('도메인 (호스트명)'), { target: { value: 'game.example.com:19090' } });
  fireEvent.click(profile.getByRole('button'));
  expect((await profile.findAllByRole('alert'))[0]!.textContent).toContain('호스트명만 입력하세요');
  expect(post).not.toHaveBeenCalled();
  fireEvent.change(profile.getByLabelText('도메인 (호스트명)'), { target: { value: 'game.example.com' } });
  fireEvent.change(profile.getByLabelText('호스트 범위'), { target: { value: 'exact' } });
  fireEvent.change(profile.getByLabelText('포트 정책'), { target: { value: 'specific' } });
  fireEvent.change(profile.getByLabelText('특정 포트'), { target: { value: '19090' } });
  fireEvent.click(profile.getByRole('button'));
  expect(form().getAllByLabelText('도메인 (호스트명)')).toHaveLength(2);
  expect(post).not.toHaveBeenCalled();
  expect((form().getAllByLabelText('도메인 (호스트명)')[1] as HTMLInputElement).value).toBe('game.example.com');
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
		expect(screen.queryByRole('button', { name: '연결 1개 신청' })).toBeNull();
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
		expect(form().getByRole('textbox', { name: '도메인 (호스트명)' }).getAttribute('placeholder')).toBe('assets.example.com');
	});
	it('defaults administrator to pending review and filters with counts', async () => {
		vi.spyOn(api, 'get').mockResolvedValue({ items: [item, { ...item, id: 'approved-1', origin: 'https://approved.example.com', state: 'APPROVED' }], gameOrigin: 'https://nas.example.com', policyVersion: null });
		mount(true);
		await screen.findByRole('button', { name: '승인' });
		expect(screen.getByText('관리자 검토 화면')).toBeTruthy();
		expect(screen.queryByText('https://approved.example.com')).toBeNull();
		expect(screen.queryByRole('button', { name: '연결 1개 신청' })).toBeNull();
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
		expect(screen.getByText(/CORS·WebSocket Origin 허용 대상/)).toBeTruthy();
		fireEvent.change(form().getByLabelText('도메인 (호스트명)'), { target: { value: 'socket.example.com' } });
		fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: '실시간 연결' } });
		fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'Origin 검사와 인증 토큰' } });
		fireEvent.click(screen.getByRole('button', { name: '연결 1개 신청' }));
		await waitFor(() => expect(post).toHaveBeenCalledWith('/api/me/projects/7/webgl-network-requests/batch', { items: [{ origin: 'wss://socket.example.com:*', mode: 'WSS', purpose: '실시간 연결', cors: 'Origin 검사와 인증 토큰' }] }));
	});

 it('rejects pasted URLs even with a matching port and submits after correcting the host', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  const post = vi.spyOn(api, 'post').mockResolvedValue(item);
  mount(); await screen.findByText('등록된 신청이 없습니다.');
  fireEvent.change(form().getByLabelText('도메인 (호스트명)'), { target: { value: 'https://ASSETS.example.com:443/' } });
  fireEvent.change(screen.getByLabelText('사용 목적'), { target: { value: 'Bundles' } });
  fireEvent.change(screen.getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'CORS enabled' } });
  fireEvent.click(screen.getByRole('button', { name: '연결 1개 신청' }));
  expect(post).not.toHaveBeenCalled();
  fireEvent.change(form().getByLabelText('포트 정책'), { target: { value: 'specific' } });
  fireEvent.click(screen.getByRole('button', { name: '연결 1개 신청' }));
  expect(post).not.toHaveBeenCalled();
  expect((form().getByLabelText('도메인 (호스트명)') as HTMLInputElement).value).toBe('https://ASSETS.example.com:443/');
  fireEvent.change(form().getByLabelText('도메인 (호스트명)'), { target: { value: 'ASSETS.example.com' } });
  const details = form().getByText('https://assets.example.com').closest('details')!;
  expect(details.open).toBe(false);
  expect(form().getByLabelText('신청 미리보기').textContent).toContain('assets.example.com');
  expect(form().getByLabelText('신청 미리보기').textContent).toContain('443기본 포트');
  fireEvent.click(screen.getByRole('button', { name: '연결 1개 신청' }));
  await waitFor(() => expect(post).toHaveBeenCalledWith(expect.any(String), { items: [expect.objectContaining({ origin: 'https://assets.example.com' })] }));
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

describe('batch editor', () => {
 async function setup() {
  vi.spyOn(api, 'get').mockResolvedValue({ items: [], gameOrigin: 'https://nas.example.com', policyVersion: 0 });
  mount(); await screen.findByText('등록된 신청이 없습니다.');
 }
 const row = (n: number) => within(form().getByRole('group', { name: `연결 ${n}` }));
 function fill(n: number, host: string) {
  fireEvent.change(row(n).getByLabelText('도메인 (호스트명)'), { target: { value: host } });
  fireEvent.change(form().getByLabelText('사용 목적'), { target: { value: 'Shared purpose' } });
  fireEvent.change(form().getByLabelText('CORS / 인증 설정 계획'), { target: { value: 'Shared config' } });
 }
 it('preserves stable controls and shared descriptions when removing the middle item; sends once', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ items: [] }); await setup();
  fireEvent.click(form().getByText('＋ 연결 추가')); fireEvent.click(form().getByText('＋ 연결 추가'));
  fill(1, 'one.example.com'); fill(2, 'two.example.com'); fill(3, 'three.example.com');
  const third = row(3).getByLabelText('도메인 (호스트명)');
  fireEvent.click(row(2).getByText('삭제'));
  expect(row(2).getByLabelText('도메인 (호스트명)')).toBe(third);
  expect((third as HTMLInputElement).value).toBe('three.example.com');
  expect(form().getAllByLabelText('사용 목적')).toHaveLength(1);
  fireEvent.click(form().getByText('연결 2개 신청'));
  await waitFor(() => expect(post).toHaveBeenCalledExactlyOnceWith('/api/me/projects/7/webgl-network-requests/batch', { items: [
   { origin: 'https://one.example.com:*', mode: 'HTTPS', purpose: 'Shared purpose', cors: 'Shared config' },
   { origin: 'https://three.example.com:*', mode: 'HTTPS', purpose: 'Shared purpose', cors: 'Shared config' },
  ] }));
  await waitFor(() => expect(form().getAllByLabelText('도메인 (호스트명)')).toHaveLength(1));
 });
 it('shows every empty-field error, focuses the first and rejects duplicates/overlap', async () => {
  const post = vi.spyOn(api, 'post'); await setup();
  fireEvent.click(form().getByText('＋ 연결 추가'));
  fireEvent.click(form().getByText('연결 2개 신청'));
  expect(form().getAllByRole('alert')).toHaveLength(4);
  expect(document.activeElement).toBe(row(1).getByLabelText('도메인 (호스트명)'));
  fill(1, 'same.example.com'); fill(2, 'same.example.com');
  fireEvent.click(form().getByText('연결 2개 신청'));
  expect(form().getAllByRole('alert')).toHaveLength(2);
  fill(1, 'example.com'); fireEvent.change(row(1).getByLabelText('호스트 범위'), { target: { value: 'subdomains' } });
  fireEvent.click(form().getByText('연결 2개 신청')); expect(form().getAllByRole('alert')).toHaveLength(2);
  expect(post).not.toHaveBeenCalled();
 });
 it('retains all inputs and maps server errors; uncertain outcomes refresh history without retry', async () => {
  const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new ApiError(409, 'Conflict', { error: { details: [{ index: 1, field: 'origin', message: '이미 등록됨' }] } })).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await setup(); fireEvent.click(form().getByText('＋ 연결 추가')); fill(1, 'one.example.com'); fill(2, 'two.example.com');
  fireEvent.click(form().getByText('연결 2개 신청'));
  await screen.findByText('이미 등록됨');
  await waitFor(() => expect(document.activeElement).toBe(row(2).getByLabelText('도메인 (호스트명)')));
  expect((form().getByLabelText('사용 목적') as HTMLTextAreaElement).value).toBe('Shared purpose');
  fireEvent.click(form().getByText('연결 2개 신청'));
  await screen.findByText(/신청 결과를 확인할 수 없습니다/);
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2)); expect(post).toHaveBeenCalledTimes(2);
  expect(form().getAllByLabelText('도메인 (호스트명)')).toHaveLength(2);
 });
 it('preserves drafts when refreshing history also fails after a lost response', async () => {
  vi.spyOn(api, 'post').mockRejectedValue(new TypeError('Lost response'));
  await setup();
  vi.mocked(api.get).mockRejectedValue(new TypeError('History unavailable'));
  fill(1, 'one.example.com'); fireEvent.click(form().getByText('연결 1개 신청'));
  await screen.findByText(/신청 이력을 새로 조회하지 못했습니다/);
  expect((form().getByLabelText('사용 목적') as HTMLTextAreaElement).value).toBe('Shared purpose');
 });
 it('locks every input and example action while a request is pending', async () => {
  let resolve!: (value: unknown) => void;
  const post = vi.spyOn(api, 'post').mockImplementation(() => new Promise(r => { resolve = r; }));
  await setup(); fill(1, 'one.example.com'); fireEvent.click(form().getByText('연결 1개 신청'));
  await waitFor(() => expect((form().getByText('＋ 연결 추가') as HTMLButtonElement).disabled).toBe(true));
  expect((form().getByLabelText('사용 목적') as HTMLTextAreaElement).disabled).toBe(true);
  expect((screen.getByLabelText('서비스') as HTMLSelectElement).disabled).toBe(true);
  fireEvent.submit(document.getElementById('network-new-request')!); expect(post).toHaveBeenCalledTimes(1);
  resolve({ items: [] }); await screen.findByText(/신청이 모두 등록되었습니다/);
 });
 it('adds mixed service examples, skips duplicates and refuses additions past sixteen', async () => {
  await setup();
  fireEvent.click(screen.getByLabelText('예시 1 선택')); fireEvent.click(screen.getByText('선택한 예시 목록에 추가'));
  fireEvent.click(screen.getByText('선택한 예시 목록에 추가')); expect(screen.getByText(/중복 1개/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('서비스'), { target: { value: 'https' } });
  fireEvent.click(screen.getByLabelText('예시 1 선택')); fireEvent.click(screen.getByText('선택한 예시 목록에 추가'));
  expect(form().getAllByLabelText('도메인 (호스트명)')).toHaveLength(3);
  for (let i = 3; i < 16; i++) fireEvent.click(form().getByText('＋ 연결 추가'));
  expect((form().getByText('＋ 연결 추가') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('서비스'), { target: { value: 'relay' } });
  fireEvent.click(screen.getByLabelText('예시 1 선택')); fireEvent.click(screen.getByText('선택한 예시 목록에 추가'));
  expect(screen.getByText(/예시를 추가하지 않았습니다/)).toBeTruthy();
  expect(form().getAllByLabelText('도메인 (호스트명)')).toHaveLength(16);
 });
 it('resets the last deleted row to a fresh empty row', async () => {
  await setup(); fill(1, 'one.example.com'); fireEvent.click(row(1).getByText('삭제'));
  expect((row(1).getByLabelText('도메인 (호스트명)') as HTMLInputElement).value).toBe('');
 });
});
