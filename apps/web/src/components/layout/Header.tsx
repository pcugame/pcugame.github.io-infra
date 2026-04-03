import { Link } from 'react-router-dom';
import { useMe } from '../../features/auth';

export function Header() {
  const { isAuthenticated, user } = useMe();

  return (
    <header className="site-topnav">
      <div className="home-topnav__inner container">
        <Link to="/" className="home-topnav__logo">
          <img src="/pcu_signature.svg" alt="배재대학교" className="home-topnav__logo-sig" draggable={false} />
          <span className="home-topnav__logo-divider" aria-hidden="true" />
          <span className="home-topnav__logo-dept">소프트웨어공학부<br />게임공학전공</span>
        </Link>

        <div className="home-topnav__actions">
          <Link to="/years" className="home-topnav__link">연도별 전시</Link>

          {isAuthenticated && user ? (
            <>
              <Link to="/admin/projects/new" className="home-topnav__btn home-topnav__btn--upload">작품 등록</Link>
              {(user.role === 'OPERATOR' || user.role === 'ADMIN') && (
                <Link to="/admin/projects" className="home-topnav__link">관리</Link>
              )}
              <Link to="/me" className="home-topnav__btn">{user.name}</Link>
            </>
          ) : (
            <Link to="/login" className="home-topnav__btn">로그인</Link>
          )}
        </div>
      </div>
    </header>
  );
}
