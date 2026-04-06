import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../components/common';

export default function YearsPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.publicYears,
    queryFn: publicApi.getYears,
  });

  const items = data?.items ?? [];

  return (
    <div className="years-landing">
      <section className="years-hero">
        <div className="container">
          <h1 className="years-hero__title">전시 목록</h1>
          <p className="years-hero__desc">
            배재대학교 게임공학과 졸업작품 아카이브를 탐색해보세요.
          </p>
        </div>
      </section>

      <section className="years-body">
        <div className="container">
          {isLoading && <LoadingSpinner />}
          {error && <ErrorMessage error={error} onReset={() => refetch()} />}

          {data && items.length === 0 && (
            <EmptyState message="등록된 전시가 없습니다." />
          )}

          {items.length > 0 && (
            <div className="years-grid">
              {items.map((ex, i) => (
                <Link to={`/exhibitions/${ex.id}`} key={ex.id} className="years-card">
                  <span className="years-card__index">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="years-card__main">
                    <span className="years-card__year">{ex.year}</span>
                    {ex.title && (
                      <span className="years-card__title">{ex.title}</span>
                    )}
                  </div>
                  <span className="years-card__count">
                    {ex.projectCount}개 작품
                  </span>
                  <span className="years-card__arrow" aria-hidden="true">&rarr;</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
