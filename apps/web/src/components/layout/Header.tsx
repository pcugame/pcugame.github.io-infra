import { Link } from 'react-router-dom';
import { useMe } from '../../features/auth';

export function Header() {
  const { isAuthenticated, user } = useMe();

  return (
    <header className="header">
      <div className="header__inner container">
        <Link to="/" className="header__logo">
          PCU 게임공학과 졸업작품 전시
        </Link>

        <nav className="header__nav">
          <Link to="/years">연도별 작품</Link>

          {isAuthenticated && user ? (
            <>
              {(user.role === 'OPERATOR' || user.role === 'ADMIN') && (
                <Link to="/admin/projects">관리</Link>
              )}
              <Link to="/me" className="header__user">
                {user.name}
              </Link>
            </>
          ) : (
            <Link to="/login" className="btn btn--small">
              로그인
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
