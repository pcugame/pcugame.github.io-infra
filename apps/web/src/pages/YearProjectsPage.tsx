import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../components/common';
import { ProjectCard } from '../components/project';

export default function YearProjectsPage() {
  const { year: yearParam } = useParams<{ year: string }>();
  const year = Number(yearParam);
  const [search, setSearch] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.yearProjects(year),
    queryFn: () => publicApi.getYearProjects(year),
    enabled: !isNaN(year),
  });

  if (isNaN(year)) {
    return <EmptyState message="잘못된 연도입니다." />;
  }

  const filtered = data?.items.filter(
    (p) =>
      p.title.toLowerCase().includes(search.toLowerCase()) ||
      p.members.some((m) => m.name.includes(search)),
  ) ?? [];

  return (
    <div className="archive-page">
      <div className="archive-page__header">
        <Link to="/years" className="archive-back">← 연도 목록</Link>
        <h1 className="archive-page__title">게임 아카이브</h1>
        <p className="archive-page__subtitle">{year}년 졸업 작품 목록을 확인하세요.</p>
      </div>

      {isLoading && <LoadingSpinner />}
      {error && <ErrorMessage error={error} onReset={() => refetch()} />}

      {data && (
        <>
          <div className="archive-page__toolbar">
            <div className="archive-search">
              <span className="archive-search__icon" aria-hidden="true">🔍</span>
              <input
                className="archive-search__input"
                type="search"
                placeholder="작품명 또는 팀원 이름으로 검색"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="작품 검색"
              />
            </div>
            <span className="archive-count">
              {filtered.length}개 작품
            </span>
          </div>

          {data.empty || filtered.length === 0 ? (
            <EmptyState
              message={
                search
                  ? `"${search}"에 해당하는 작품이 없습니다.`
                  : '해당 연도 작품이 아직 등록되지 않았습니다.'
              }
            />
          ) : (
            <div className="archive-grid">
              {filtered.map((project) => (
                <ProjectCard key={project.id} project={project} year={year} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
