import { NavLink, Outlet } from 'react-router-dom';

export function AdminLayout() {
  return (
    <div className="admin-layout">
      <nav className="admin-sidebar">
        <h3 className="admin-sidebar__title">관리자</h3>
        <ul className="admin-sidebar__nav">
          <li>
            <NavLink to="/admin/projects" end>
              작품 관리
            </NavLink>
          </li>
          <li>
            <NavLink to="/admin/projects/new">작품 등록</NavLink>
          </li>
          <li>
            <NavLink to="/admin/years">연도 관리</NavLink>
          </li>
        </ul>
      </nav>
      <div className="admin-content">
        <Outlet />
      </div>
    </div>
  );
}
