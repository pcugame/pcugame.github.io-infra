// ── 로그인 필수 라우트 가드 ──────────────────────────────────

import { Navigate, useLocation } from 'react-router-dom';
import { useMe } from './useMe';

interface Props {
  children: React.ReactNode;
}

export function RequireAuth({ children }: Props) {
  const { isAuthenticated, isLoading } = useMe();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="page-center">
        <p>인증 확인 중…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
