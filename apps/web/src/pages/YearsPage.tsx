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

  return (
    <div className="years-page">
      <h1>연도별 전시</h1>

      {isLoading && <LoadingSpinner />}
      {error && <ErrorMessage error={error} onReset={() => refetch()} />}

      {data && data.items.length === 0 && (
        <EmptyState message="등록된 전시 연도가 없습니다." />
      )}

      {data && data.items.length > 0 && (
        <div className="year-list">
          {data.items.map((y) => (
              <Link to={`/years/${y.year}`} key={y.id} className="year-list-item">
                <h2>{y.year}년</h2>
                {y.title && <p className="year-list-item__title">{y.title}</p>}
                <p className="year-list-item__count">{y.projectCount}개 작품</p>
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}
