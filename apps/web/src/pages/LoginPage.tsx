import { useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useMe, useLogin } from '../features/auth';
import type { DevAuthErrorScenario, UserRole } from '../contracts';
import { initializeGoogleSignIn } from '../lib/auth';
import { getApiErrorCode, getApiErrorMessage, isApiError } from '../lib/api';

const SCHOOL_DOMAIN_ERROR_CODES = new Set(['EMAIL_DOMAIN_NOT_ALLOWED', 'DOMAIN_NOT_ALLOWED']);

const DEV_AUTH_ROLES: { role: UserRole; label: string }[] = [
  { role: 'USER', label: '학생' },
  { role: 'OPERATOR', label: '운영자' },
  { role: 'ADMIN', label: '관리자' },
];

const DEV_AUTH_ERROR_SCENARIOS: { scenario: DevAuthErrorScenario; label: string }[] = [
  { scenario: 'domain-not-allowed', label: '비정상 도메인' },
  { scenario: 'google-api-unavailable', label: 'Google API 연결 실패' },
  { scenario: 'invalid-google-token', label: '잘못된 Google 토큰' },
  { scenario: 'missing-google-payload', label: 'Google payload 누락' },
  { scenario: 'api-server-error', label: 'API 서버 오류' },
];

function isDevAuthUiEnabled(): boolean {
  return import.meta.env.VITE_DEV_AUTH_ENABLED === 'true' && !import.meta.env.PROD;
}

function isSchoolDomainError(error: unknown): boolean {
  const code = getApiErrorCode(error);
  if (code && SCHOOL_DOMAIN_ERROR_CODES.has(code)) return true;

  if (!isApiError(error)) return false;
  const message = getApiErrorMessage(error).toLowerCase();
  return message.includes('domain') && message.includes('not allowed');
}

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated } = useMe();
  const loginMutation = useLogin();
  const devAuthMode = isDevAuthUiEnabled();

  const googleBtnRef = useRef<HTMLDivElement>(null);
  const mutateRef = useRef(loginMutation.mutate);
  useEffect(() => {
    mutateRef.current = loginMutation.mutate;
  });

  // 이미 로그인 상태이면 이전 페이지 또는 홈으로 이동
  useEffect(() => {
    if (isAuthenticated) {
      const raw = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/';
      // Open Redirect 방어: 상대 경로('/'로 시작)만 허용, 프로토콜 우회('//' 등) 차단
      const from = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
      navigate(from, { replace: true });
    }
  }, [isAuthenticated, navigate, location.state]);

  // Google 버튼 초기화 — isAuthenticated가 바뀔 때만 실행
  useEffect(() => {
    if (devAuthMode) return;
    if (googleBtnRef.current && !isAuthenticated) {
      initializeGoogleSignIn(googleBtnRef.current, (credential: string) => {
        mutateRef.current(credential);
      });
    }
  }, [devAuthMode, isAuthenticated]);

  // 학교 도메인 제한 오류 → 전용 안내
  const errorMessage = loginMutation.error
    ? isSchoolDomainError(loginMutation.error)
      ? '배재대학교 계정(@pcu.ac.kr)으로만 로그인할 수 있습니다.'
      : getApiErrorMessage(loginMutation.error)
    : null;

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>로그인</h1>
        <p>배재대학교 Google 계정으로 로그인하세요.</p>

        {devAuthMode ? (
          <div className="dev-auth-panel" data-testid="dev-auth-panel">
            <div className="dev-auth-panel__group" aria-label="테스트 역할 로그인">
              {DEV_AUTH_ROLES.map((item) => (
                <button
                  key={item.role}
                  type="button"
                  className="btn btn-primary"
                  disabled={loginMutation.isPending}
                  onClick={() => loginMutation.mutate({ type: 'dev-role', role: item.role })}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="dev-auth-panel__errors" aria-label="로그인 실패 시뮬레이션">
              {DEV_AUTH_ERROR_SCENARIOS.map((item) => (
                <button
                  key={item.scenario}
                  type="button"
                  className="btn btn-secondary"
                  disabled={loginMutation.isPending}
                  onClick={() => loginMutation.mutate({ type: 'dev-error', scenario: item.scenario })}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div ref={googleBtnRef} className="google-btn-container" />

            <a
              href="https://www.pcu.ac.kr/kor/contents/130"
              target="_blank"
              rel="noopener noreferrer"
              className="login-ucm-link"
            >
              UCM 계정에 대해 모르겠어요
              <svg className="login-ucm-link__icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="6" y="1" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                <rect x="1" y="6" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.5" fill="var(--color-surface)"/>
              </svg>
            </a>
          </>
        )}

        {loginMutation.isPending && <p className="login-status">로그인 처리 중…</p>}

        {errorMessage && (
          <div className="error-box" role="alert">
            <p>{errorMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
}
