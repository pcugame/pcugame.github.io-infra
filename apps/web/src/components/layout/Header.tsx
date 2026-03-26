import { Link } from 'react-router-dom';
import { useMe } from '../../features/auth';
import { useTheme } from '../../hooks/useTheme';

export function Header() {
  const { isAuthenticated, user } = useMe();
  const { theme, toggle } = useTheme();

  return (
    <header className="header">
      <div className="header__inner container">
        <Link to="/" className="header__logo">
          <img src="/pcu_signature.svg" alt="배재대학교" className="header__logo-sig" draggable={false} />
          <span className="header__logo-divider" aria-hidden="true" />
          <span className="header__logo-dept">소프트웨어공학부<br />게임공학전공</span>
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

          <button
            className="theme-toggle"
            onClick={toggle}
            aria-label={theme === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환'}
            title={theme === 'dark' ? '라이트 모드' : '다크 모드'}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </nav>
      </div>
    </header>
  );
}
