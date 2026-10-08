import { useMe } from '../../features/auth';
import { Outlet, useLocation } from 'react-router-dom';
import { Header } from './Header';
import { MobileBottomNav } from './MobileBottomNav';
import { MobileTopBar } from './MobileTopBar';
import { MockRoleSwitcher } from '../common/MockRoleSwitcher';

export function Layout() {
  const { pathname } = useLocation();
  const { user } = useMe();
  const isStudentEditor = user?.role === 'USER' && /^\/admin\/projects\/[^/]+\/edit\/?$/.test(pathname);
  const isHome = pathname === '/';
  const isFullWidth = isHome || pathname.startsWith('/years') || pathname.startsWith('/exhibitions') || (pathname.startsWith('/admin') && !isStudentEditor);
  return (
    <div className="layout home-landing">
      {!isHome && <Header />}
      <MobileTopBar />
      <main className={isFullWidth ? 'main main--home' : 'main container'}>
        <Outlet />
      </main>
      <MobileBottomNav />
      <MockRoleSwitcher />
    </div>
  );
}
