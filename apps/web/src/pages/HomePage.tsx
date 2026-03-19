import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { LoadingSpinner, ErrorMessage } from '../components/common';

export default function HomePage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.publicYears,
    queryFn: publicApi.getYears,
  });

  return (
    <div className="home-page">
      <section className="hero">
        <h1>배재대학교 게임공학과</h1>
        <h2>졸업작품 전시</h2>
        <p>학생들이 만든 창의적인 게임 작품을 만나보세요.</p>
        <Link to="/years" className="btn btn--primary btn--large">
          작품 보러가기
        </Link>
      </section>

      <section className="home-years">
        <h3>연도별 전시</h3>

        {isLoading && <LoadingSpinner />}
        {error && <ErrorMessage error={error} onReset={() => refetch()} />}

        {data && (
          <div className="year-grid">
            {data.items
              .filter((y) => y.isPublished)
              .map((y) => (
                <Link to={`/years/${y.year}`} key={y.id} className="year-card">
                  <span className="year-card__year">{y.year}</span>
                  {y.title && <span className="year-card__title">{y.title}</span>}
                  <span className="year-card__count">{y.projectCount}개 작품</span>
                </Link>
              ))}
          </div>
        )}
      </section>
    </div>
  );
}
