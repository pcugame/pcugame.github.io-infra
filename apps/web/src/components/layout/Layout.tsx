import { Outlet, useLocation } from 'react-router-dom';
import { Header } from './Header';
import { Footer } from './Footer';

export function Layout() {
  const { pathname } = useLocation();
  const isHome = pathname === '/';

  return (
    <div className="layout">
      <Header />
      <main className={isHome ? 'main main--home' : 'main container'}>
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
