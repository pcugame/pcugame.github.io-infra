/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from '../pages/LoginPage';
import { useMe, useLogout } from '../features/auth';
import { isMacSafari } from '../features/auth/browser';

const google = vi.hoisted(() => ({ callback: undefined as undefined | ((token: string) => void) }));
vi.mock('../lib/auth', () => ({
  initializeGoogleSignIn: (_: HTMLElement, callback: (token: string) => void) => { google.callback = callback; },
}));

const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const user = { id: 7, email: 'student@pcu.ac.kr', name: '학생', role: 'USER' };
const envelope = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
let loggedIn: boolean;
let acceptCookie: boolean;
let lookupFailure: boolean;
let loginError: string | undefined;
let releaseLookup: (() => void) | undefined;
let pauseLookup: boolean;
let requests: { path: string; credentials: RequestCredentials | undefined }[];

function ProtectedPage() {
  const { isAuthenticated } = useMe();
  const logout = useLogout();
  return <><p>{isAuthenticated ? '인증된 원래 화면' : '비로그인'}</p><button onClick={() => logout.mutate()}>로그아웃</button></>;
}

function renderApp(path = '/login') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[{ pathname: path, state: { from: { pathname: '/private' } } }]}>
      <Routes><Route path="/login" element={<LoginPage />} /><Route path="/private" element={<ProtectedPage />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>);
}

beforeEach(() => {
  loggedIn = false;
  acceptCookie = true;
  lookupFailure = false;
  loginError = undefined;
  pauseLookup = false;
  releaseLookup = undefined;
  requests = [];
  vi.stubEnv('VITE_DEV_AUTH_ENABLED', 'false');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(safari);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({ path, credentials: init.credentials });
    if (path === '/api/auth/google') {
      if (loginError) return new Response(JSON.stringify({ ok: false, error: { code: loginError, message: 'Invalid Google token' } }), { status: 401 });
      loggedIn = acceptCookie;
      return envelope({ user });
    }
    if (path === '/api/auth/logout') { loggedIn = false; return envelope({ message: 'Logged out' }); }
    if (path === '/api/me') {
      if (pauseLookup) await new Promise<void>(resolve => { releaseLookup = resolve; });
      if (lookupFailure) throw new TypeError('Failed to fetch');
      return envelope(loggedIn ? { authenticated: true, user } : { authenticated: false });
    }
    throw new Error(`Unexpected request: ${path}`);
  }));
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function startLogin() {
  renderApp();
  await waitFor(() => expect(requests.filter(r => r.path === '/api/me')).toHaveLength(1));
  await act(async () => { google.callback?.('test-token'); });
}

describe('login session verification through the real client and hooks', () => {
  it('returns to the original page, survives remount and logs out', async () => {
    await startLogin();
    await screen.findByText('인증된 원래 화면');
    expect(requests.map(r => r.path)).toEqual(['/api/me', '/api/auth/google', '/api/me']);
    expect(requests.every(r => r.credentials === 'include')).toBe(true);
    cleanup();
    renderApp('/private');
    await screen.findByText('인증된 원래 화면');
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    await screen.findByRole('heading', { name: '로그인' });
    expect(loggedIn).toBe(false);
  });

  it('shows Safari guidance when login succeeds but the session is absent, and supports retry', async () => {
    acceptCookie = false;
    await startLogin();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('로그인 상태를 유지하지 못했어요.');
    expect(alert.textContent).toContain('크로스 사이트 추적 방지');
    expect(alert.textContent).toContain('다른 사이트에도 적용');
    expect(screen.queryByText('인증된 원래 화면')).toBeNull();
    acceptCookie = true;
    await act(async () => { google.callback?.('test-token'); });
    await screen.findByText('인증된 원래 화면');
  });

  it('shows general cookie guidance outside Mac Safari', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/130.0 Safari/537.36');
    acceptCookie = false;
    await startLogin();
    expect((await screen.findByRole('alert')).textContent).toContain('브라우저의 쿠키 설정');
    expect(screen.queryByText(/크로스 사이트 추적 방지/)).toBeNull();
  });

  it('keeps session lookup network failures separate from cookie guidance', async () => {
    renderApp();
    await waitFor(() => expect(requests).toHaveLength(1));
    lookupFailure = true;
    await act(async () => { google.callback?.('test-token'); });
    expect((await screen.findByRole('alert')).textContent).toContain('네트워크 연결');
    expect(screen.queryByText(/크로스 사이트 추적 방지/)).toBeNull();
  });

  it.each(['EMAIL_DOMAIN_NOT_ALLOWED', 'UNAUTHORIZED'])('preserves login error %s without a session probe', async code => {
    loginError = code;
    await startLogin();
    expect((await screen.findByRole('alert')).textContent).toContain(code === 'EMAIL_DOMAIN_NOT_ALLOWED' ? '배재대학교 계정' : 'Invalid Google token');
    expect(requests.filter(r => r.path === '/api/me')).toHaveLength(1);
    expect(screen.queryByText(/크로스 사이트 추적 방지/)).toBeNull();
  });

  it('stays pending and ignores duplicate credentials while checking the session', async () => {
    renderApp();
    await waitFor(() => expect(requests).toHaveLength(1));
    pauseLookup = true;
    await act(async () => { google.callback?.('test-token'); });
    await waitFor(() => expect(releaseLookup).toBeTypeOf('function'));
    expect(screen.getByText('로그인 처리 중…')).toBeTruthy();
    await act(async () => { google.callback?.('duplicate'); });
    expect(requests.filter(r => r.path === '/api/auth/google')).toHaveLength(1);
    await act(async () => { releaseLookup?.(); });
    await screen.findByText('인증된 원래 화면');
  });
});

describe('Mac Safari guidance selection', () => {
  it('recognizes desktop Safari', () => expect(isMacSafari(safari)).toBe(true));
  it.each([
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0',
    'Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/130.0',
    safari.replace(' Safari/', ' Mobile/15E148 Safari/'),
    safari.replace('Macintosh', 'iPhone'),
  ])('does not offer Mac Safari settings for %s', ua => expect(isMacSafari(ua)).toBe(false));
});
