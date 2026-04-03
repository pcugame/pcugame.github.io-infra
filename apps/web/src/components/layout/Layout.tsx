import { Outlet, useLocation } from 'react-router-dom';
import { Header } from './Header';
import { MobileBottomNav } from './MobileBottomNav';
import { MobileTopBar } from './MobileTopBar';

export function Layout() {
  const { pathname } = useLocation();
  const isHome = pathname === '/';
  const isFullWidth = isHome || pathname.startsWith('/years') || pathname.startsWith('/admin');
  return (
    <div className="layout home-landing">
      {!isHome && <Header />}
      <MobileTopBar />
      <main className={isFullWidth ? 'main main--home' : 'main container'}>
        <Outlet />
      </main>
      <MobileBottomNav />
    </div>
  );
}
