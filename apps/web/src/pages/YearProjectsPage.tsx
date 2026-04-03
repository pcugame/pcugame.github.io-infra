import { useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../components/common';
import { ProjectCard, ProjectModal } from '../components/project';

export default function YearProjectsPage() {
  const { year: yearParam } = useParams<{ year: string }>();
  const year = Number(yearParam);
  const [search, setSearch] = useState('');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>(null); // null = 전체
  const closeModal = useCallback(() => setSelectedSlug(null), []);

  const { data: yearsData } = useQuery({
    queryKey: queryKeys.publicYears,
    queryFn: publicApi.getYears,
  });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.yearProjects(year),
    queryFn: () => publicApi.getYearProjects(year),
    enabled: !isNaN(year),
  });

  if (isNaN(year)) {
    return <EmptyState message="잘못된 연도입니다." />;
  }

  // 같은 연도의 전시회 이름들 중 첫 번째를 기본 타이틀로
  const yearItems = yearsData?.items.filter((y) => y.year === year) ?? [];
  const pageTitle = yearItems[0]?.title || `${year}년도 졸업전시회`;

  const exhibitions = data?.exhibitions ?? [];
  const hasMultipleExhibitions = exhibitions.length > 1;

  // 탭 필터링
  const tabFiltered = activeTab
    ? data?.items.filter((p) => p.exhibitionId === activeTab) ?? []
    : data?.items ?? [];

  // 검색 필터링
  const filtered = tabFiltered.filter(
    (p) =>
      p.title.toLowerCase().includes(search.toLowerCase()) ||
      p.members.some((m) => m.name.includes(search)),
  );

  return (
    <div className="archive-page">
      <div className="archive-page__header">
        <div className="container">
          <Link to="/" className="archive-back">&larr; 연도 목록</Link>
          <h1 className="archive-page__title">{pageTitle}</h1>
          <p className="archive-page__subtitle">{year}년 작품 목록을 확인하세요.</p>
        </div>
      </div>

      <div className="container">
        {isLoading && <LoadingSpinner />}
        {error && <ErrorMessage error={error} onReset={() => refetch()} />}

        {data && (
          <>
            {/* 전시회 탭 (2개 이상일 때만 표시) */}
            {hasMultipleExhibitions && (
              <div className="exhibition-tabs">
                <button
                  className={`exhibition-tab ${activeTab === null ? 'exhibition-tab--active' : ''}`}
                  onClick={() => setActiveTab(null)}
                >
                  전체
                  <span className="exhibition-tab__count">{data.items.length}</span>
                </button>
                {exhibitions.map((ex) => {
                  const count = data.items.filter((p) => p.exhibitionId === ex.id).length;
                  return (
                    <button
                      key={ex.id}
                      className={`exhibition-tab ${activeTab === ex.id ? 'exhibition-tab--active' : ''}`}
                      onClick={() => setActiveTab(ex.id)}
                    >
                      {ex.title}
                      <span className="exhibition-tab__count">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="archive-page__toolbar">
              <div className="archive-search">
                <span className="archive-search__icon" aria-hidden="true">&#x1F50D;</span>
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
                  <ProjectCard key={project.id} project={project} year={year} onSelect={setSelectedSlug} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {selectedSlug && (
        <ProjectModal slug={selectedSlug} year={year} onClose={closeModal} />
      )}
    </div>
  );
}
