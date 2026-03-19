import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../components/common';
import { ProjectCard } from '../components/project';

export default function YearProjectsPage() {
  const { year: yearParam } = useParams<{ year: string }>();
  const year = Number(yearParam);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.yearProjects(year),
    queryFn: () => publicApi.getYearProjects(year),
    enabled: !isNaN(year),
  });

  if (isNaN(year)) {
    return <EmptyState message="잘못된 연도입니다." />;
  }

  return (
    <div className="year-projects-page">
      <h1>{year}년 졸업작품</h1>

      {isLoading && <LoadingSpinner />}
      {error && <ErrorMessage error={error} onReset={() => refetch()} />}

      {data && data.empty && (
        <EmptyState message="해당 연도 작품이 아직 등록되지 않았습니다." />
      )}

      {data && !data.empty && (
        <div className="project-grid">
          {data.items.map((project) => (
            <ProjectCard key={project.id} project={project} year={year} />
          ))}
        </div>
      )}
    </div>
  );
}
