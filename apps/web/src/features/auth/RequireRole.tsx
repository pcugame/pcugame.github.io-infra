// ── 역할 기반 라우트 가드 ────────────────────────────────────

import type { UserRole } from '../../contracts';
import { useMe } from './useMe';

interface Props {
  /** 허용할 역할 목록 */
  allowed: UserRole[];
  children: React.ReactNode;
}

/**
 * RequireAuth 내부에서 사용된다고 가정.
 * 역할이 부족하면 403 안내를 표시한다.
 */
export function RequireRole({ allowed, children }: Props) {
  const { user } = useMe();

  if (!user || !allowed.includes(user.role)) {
    return (
      <div className="page-center">
        <h2>접근 권한이 없습니다</h2>
        <p>이 페이지에 접근하려면 적절한 권한이 필요합니다.</p>
      </div>
    );
  }

  return <>{children}</>;
}
