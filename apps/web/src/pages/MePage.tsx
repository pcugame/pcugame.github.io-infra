import { Link } from 'react-router-dom';
import { useMe, useLogout } from '../features/auth';
import { LoadingSpinner } from '../components/common';

const ROLE_LABELS: Record<string, string> = {
  USER: '일반 사용자',
  OPERATOR: '운영자',
  ADMIN: '관리자',
};

const ROLE_BADGE: Record<string, string> = {
  USER: 'me-role--user',
  OPERATOR: 'me-role--operator',
  ADMIN: 'me-role--admin',
};

export default function MePage() {
  const { user, isLoading } = useMe();
  const logout = useLogout();

  if (isLoading) return <LoadingSpinner />;
  if (!user) return null;

  return (
    <div className="me-page">
      {/* Profile header */}
      <div className="me-profile">
        <div className="me-profile__avatar" aria-hidden="true">
          {user.name.charAt(0)}
        </div>
        <h1 className="me-profile__name">{user.name}</h1>
        <span className={`me-profile__role ${ROLE_BADGE[user.role] ?? ''}`}>
          {ROLE_LABELS[user.role] ?? user.role}
        </span>
      </div>

      {/* Info card */}
      <div className="me-card">
        <ul className="me-info-list">
          <li className="me-info-item">
            <span className="me-info-item__label">이메일</span>
            <span className="me-info-item__value">{user.email}</span>
          </li>
          {user.studentId && (
            <li className="me-info-item">
              <span className="me-info-item__label">학번</span>
              <span className="me-info-item__value">{user.studentId}</span>
            </li>
          )}
          <li className="me-info-item">
            <span className="me-info-item__label">권한</span>
            <span className="me-info-item__value">{ROLE_LABELS[user.role] ?? user.role}</span>
          </li>
        </ul>
      </div>

      <Link to="/me/projects" className="btn btn--secondary" style={{ marginBottom: '0.75rem' }}>
        내 작품 관리
      </Link>

      {/* Logout */}
      <button
        className="btn btn--danger me-logout-btn"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
      >
        {logout.isPending ? '로그아웃 중…' : '로그아웃'}
      </button>
    </div>
  );
}
