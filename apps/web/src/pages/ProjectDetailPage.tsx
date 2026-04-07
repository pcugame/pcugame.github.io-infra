import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { LoadingSpinner, ErrorMessage } from '../components/common';
import { ProjectVideo } from '../components/project';

export default function ProjectDetailPage() {
  const { year: yearParam, slug, projectId } = useParams<{
    year?: string;
    slug?: string;
    projectId?: string;
  }>();

  const year = yearParam ? Number(yearParam) : undefined;
  const idOrSlug = slug ?? projectId ?? '';
  const numericId = projectId ? Number(projectId) : NaN;

  const { data: project, isLoading, error, refetch } = useQuery({
    queryKey: slug && year
      ? queryKeys.projectDetail(year, slug)
      : queryKeys.projectDetailById(numericId),
    queryFn: () => publicApi.getProjectDetail(
      !isNaN(numericId) ? numericId : idOrSlug,
      year,
    ),
    enabled: !!idOrSlug,
  });

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;
  if (!project) return null;

  const galleryImages = project.images.filter((img) => img.kind === 'IMAGE');

  return (
    <div className="project-detail">
      {/* 뒤로가기 */}
      {year && (
        <Link to={`/years/${year}`} className="back-link">
          &larr; {year}년 목록으로
        </Link>
      )}

      <h1>
        {project.title}
        {project.isLegacy && (
          <span className="legacy-badge" title="아카이브 자료 — 일부 정보가 누락되었을 수 있습니다">
            아카이브
          </span>
        )}
      </h1>

      {/* Legacy 안내 */}
      {project.isLegacy && (
        <p className="legacy-notice">
          이 프로젝트는 아카이브 자료입니다. 일부 자료(실행 파일, 스크린샷 등)가 누락되었을 수 있습니다.
        </p>
      )}

      {/* 참여 학생 */}
      <section className="project-detail__members">
        <h3>참여 학생</h3>
        <ul>
          {project.members.map((m) => (
            <li key={m.id}>
              {m.name} <small>({m.studentId})</small>
            </li>
          ))}
        </ul>
      </section>

      {/* 요약 */}
      {project.summary && (
        <section className="project-detail__summary">
          <p>{project.summary}</p>
        </section>
      )}

      {/* 포스터 */}
      {project.posterUrl && (
        <section className="project-detail__poster">
          <img src={project.posterUrl} alt={`${project.title} 포스터`} />
        </section>
      )}

      {/* 상세 설명 */}
      {project.description && (
        <section className="project-detail__description">
          <h3>상세 설명</h3>
          <div className="prose">{project.description}</div>
        </section>
      )}

      {/* 영상 */}
      {(project.video || project.posterUrl) && (
        <section className="project-detail__video">
          <h3>영상</h3>
          <ProjectVideo
            video={project.video}
            posterUrl={project.posterUrl}
            title={project.title}
          />
        </section>
      )}

      {/* 이미지 갤러리 */}
      {galleryImages.length > 0 && (
        <section className="project-detail__gallery">
          <h3>스크린샷</h3>
          <div className="gallery-grid">
            {galleryImages.map((img) => (
              <img key={img.id} src={img.url} alt="게임 스크린샷" loading="lazy" />
            ))}
          </div>
        </section>
      )}

      {/* 게임 다운로드 — GAME files are always publicly downloadable */}
      {project.gameDownloadUrl && (
        <section className="project-detail__download">
          <h3>게임 다운로드</h3>
          <a
            href={project.gameDownloadUrl}
            className="btn btn--primary"
            download
          >
            다운로드 (ZIP)
          </a>
        </section>
      )}
    </div>
  );
}
