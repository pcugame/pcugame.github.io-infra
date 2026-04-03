import type { ReactElement } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useMe } from '../../features/auth';

type NavItem = { to: string; label: string; icon: string; end: boolean };

const ADMIN_NAV: NavItem[] = [
  { to: '/admin/projects', label: '작품 관리', icon: 'grid', end: true },
  { to: '/admin/projects/new', label: '작품 등록', icon: 'plus', end: false },
  { to: '/admin/years', label: '연도 관리', icon: 'calendar', end: false },
  { to: '/admin/settings', label: '사이트 설정', icon: 'settings', end: false },
  { to: '/admin/banned-ips', label: 'IP 차단 관리', icon: 'shield', end: false },
];

const USER_NAV: NavItem[] = [
  { to: '/admin/projects/new', label: '작품 등록', icon: 'plus', end: false },
];

const ICONS: Record<string, ReactElement> = {
  grid: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
    </svg>
  ),
  plus: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  ),
  calendar: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  shield: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
};

export function AdminLayout() {
  const { user } = useMe();
  const isAdmin = user?.role === 'OPERATOR' || user?.role === 'ADMIN';
  const navItems = isAdmin ? ADMIN_NAV : USER_NAV;
  const title = isAdmin ? '관리자 패널' : '작품 등록';

  return (
    <div className="admin-layout">
      <nav className="admin-sidebar">
        <div className="admin-sidebar__header">
          <span className="admin-sidebar__eyebrow">게임공학과 작품전시</span>
          <h3 className="admin-sidebar__title">{title}</h3>
        </div>
        <ul className="admin-sidebar__nav">
          {navItems.map(({ to, label, icon, end }) => (
            <li key={to}>
              <NavLink to={to} end={end}>
                {ICONS[icon]}
                <span>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="admin-sidebar__footer">
          <NavLink to="/" className="admin-sidebar__back">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
            </svg>
            사이트로 돌아가기
          </NavLink>
        </div>
      </nav>
      <main className="admin-content">
        <Outlet />
      </main>
    </div>
  );
}
