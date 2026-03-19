import { useEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useMe, useLogin } from '../features/auth';
import { initializeGoogleSignIn } from '../lib/auth';
import { getApiErrorMessage, isApiError } from '../lib/api';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated } = useMe();
  const loginMutation = useLogin();

  const googleBtnRef = useRef<HTMLDivElement>(null);

  // 이미 로그인 상태이면 이전 페이지 또는 홈으로 이동
  useEffect(() => {
    if (isAuthenticated) {
      const raw = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/';
      // Open Redirect 방어: 상대 경로('/'로 시작)만 허용, 프로토콜 우회('//' 등) 차단
      const from = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
      navigate(from, { replace: true });
    }
  }, [isAuthenticated, navigate, location.state]);

  const handleCredential = useCallback(
    (credential: string) => {
      loginMutation.mutate(credential);
    },
    [loginMutation],
  );

  useEffect(() => {
    if (googleBtnRef.current && !isAuthenticated) {
      initializeGoogleSignIn(googleBtnRef.current, handleCredential);
    }
  }, [isAuthenticated, handleCredential]);

  // 403 → 학교 도메인 안내
  const errorMessage = loginMutation.error
    ? isApiError(loginMutation.error) && loginMutation.error.status === 403
      ? '배재대학교 계정(@pcu.ac.kr)으로만 로그인할 수 있습니다.'
      : getApiErrorMessage(loginMutation.error)
    : null;

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>로그인</h1>
        <p>배재대학교 Google 계정으로 로그인하세요.</p>

        <div ref={googleBtnRef} className="google-btn-container" />

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
