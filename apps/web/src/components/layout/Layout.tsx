import { Outlet, useLocation } from 'react-router-dom';
import { Header } from './Header';
import { Footer } from './Footer';

export function Layout() {
  const { pathname } = useLocation();
  const isHome = pathname === '/';
  const isFullWidth = isHome || pathname.startsWith('/years');

  return (
    <div className="layout">
      {!isHome && <Header />}
      <main className={isFullWidth ? 'main main--home' : 'main container'}>
        <Outlet />
      </main>
      {!isHome && <Footer />}
    </div>
  );
}
