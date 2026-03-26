import { useMe, useLogout } from '../features/auth';
import { LoadingSpinner } from '../components/common';

const ROLE_LABELS: Record<string, string> = {
  USER: '일반 사용자',
  OPERATOR: '운영자',
  ADMIN: '관리자',
};

export default function MePage() {
  const { user, isLoading } = useMe();
  const logout = useLogout();

  if (isLoading) return <LoadingSpinner />;
  if (!user) return null;

  return (
    <div className="me-page">
      <h1>내 정보</h1>

      <div className="me-card">
        <dl className="info-list">
          <dt>이름</dt>
          <dd>{user.name}</dd>

          <dt>이메일</dt>
          <dd>{user.email}</dd>

          <dt>권한</dt>
          <dd>{ROLE_LABELS[user.role] ?? user.role}</dd>
        </dl>

        <button
          className="btn btn--danger"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
        >
          {logout.isPending ? '로그아웃 중…' : '로그아웃'}
        </button>
      </div>
    </div>
  );
}
