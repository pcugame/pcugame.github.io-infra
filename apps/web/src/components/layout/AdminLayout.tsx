import type { ReactElement } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/admin/projects', label: '작품 관리', icon: 'grid', end: true },
  { to: '/admin/projects/new', label: '작품 등록', icon: 'plus', end: false },
  { to: '/admin/years', label: '연도 관리', icon: 'calendar', end: false },
] as const;

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
};

export function AdminLayout() {
  return (
    <div className="admin-layout">
      <nav className="admin-sidebar">
        <div className="admin-sidebar__header">
          <span className="admin-sidebar__eyebrow">게임공학과 작품전시</span>
          <h3 className="admin-sidebar__title">관리자 패널</h3>
        </div>
        <ul className="admin-sidebar__nav">
          {NAV_ITEMS.map(({ to, label, icon, end }) => (
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
