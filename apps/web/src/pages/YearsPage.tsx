import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../components/common';
import type { PublicYearItem } from '../contracts';

interface GroupedYear {
  year: number;
  title?: string;
  projectCount: number;
}

function groupYearsByNumber(items: PublicYearItem[]): GroupedYear[] {
  const map = new Map<number, GroupedYear>();
  for (const item of items) {
    const existing = map.get(item.year);
    if (existing) {
      existing.projectCount += item.projectCount;
    } else {
      map.set(item.year, {
        year: item.year,
        title: item.title,
        projectCount: item.projectCount,
      });
    }
  }
  return Array.from(map.values());
}

export default function YearsPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.publicYears,
    queryFn: publicApi.getYears,
  });

  const items = groupYearsByNumber(data?.items ?? []);

  return (
    <div className="years-landing">
      <section className="years-hero">
        <div className="container">
          <h1 className="years-hero__title">연도별 전시</h1>
          <p className="years-hero__desc">
            배재대학교 게임공학과 졸업작품 아카이브를 연도별로 탐색해보세요.
          </p>
        </div>
      </section>

      <section className="years-body">
        <div className="container">
          {isLoading && <LoadingSpinner />}
          {error && <ErrorMessage error={error} onReset={() => refetch()} />}

          {data && items.length === 0 && (
            <EmptyState message="등록된 전시 연도가 없습니다." />
          )}

          {items.length > 0 && (
            <div className="years-grid">
              {items.map((y, i) => (
                <Link to={`/years/${y.year}`} key={y.year} className="years-card">
                  <span className="years-card__index">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="years-card__main">
                    <span className="years-card__year">{y.year}</span>
                    {y.title && (
                      <span className="years-card__title">{y.title}</span>
                    )}
                  </div>
                  <span className="years-card__count">
                    {y.projectCount}개 작품
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
