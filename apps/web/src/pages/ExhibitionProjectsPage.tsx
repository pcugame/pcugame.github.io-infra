import { useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../components/common';
import { ProjectCard, ProjectModal } from '../components/project';

export default function ExhibitionProjectsPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const id = Number(idParam);
  const [search, setSearch] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 250, isComposing);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const closeModal = useCallback(() => setSelectedSlug(null), []);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.exhibitionProjects(id),
    queryFn: () => publicApi.getExhibitionProjects(id),
    enabled: !isNaN(id),
  });

  if (isNaN(id)) {
    return <EmptyState message="잘못된 전시 ID입니다." />;
  }

  const exhibition = data?.exhibition;
  const year = exhibition?.year ?? 0;
  const pageTitle = exhibition
    ? (exhibition.title ? `${year} ${exhibition.title}` : `${year} 전시`)
    : '전시';

  // 검색 필터링
  const filtered = (data?.items ?? []).filter(
    (p) =>
      p.title.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
      p.members.some((m) => m.name.includes(debouncedSearch)),
  );

  return (
    <div className="archive-page">
      <div className="archive-page__header">
        <div className="container">
          <Link to="/years" className="archive-back">&larr; 전시 목록</Link>
          <h1 className="archive-page__title">{pageTitle}</h1>
        </div>
      </div>

      <div className="container">
        {isLoading && <LoadingSpinner />}
        {error && <ErrorMessage error={error} onReset={() => refetch()} />}

        {data && (
          <>
            <div className="archive-page__toolbar">
              <div className="archive-search">
                <span className="archive-search__icon" aria-hidden="true">&#x1F50D;</span>
                <input
                  className="archive-search__input"
                  type="search"
                  placeholder="작품명 또는 팀원 이름으로 검색"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onCompositionStart={() => setIsComposing(true)}
                  onCompositionEnd={(e) => {
                    setIsComposing(false);
                    setSearch((e.target as HTMLInputElement).value);
                  }}
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
                  debouncedSearch
                    ? `"${debouncedSearch}"에 해당하는 작품이 없습니다.`
                    : '해당 전시에 작품이 아직 등록되지 않았습니다.'
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
