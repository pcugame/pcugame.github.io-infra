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
        {project.isIncomplete && (
          <span className="incomplete-badge" title="일부 자료가 누락되었을 수 있습니다">
            불완전
          </span>
        )}
      </h1>

      {/* 에셋 유실 안내 */}
      {project.isIncomplete && !project.posterUrl && !project.gameDownloadUrl && !project.video && project.images.length === 0 && (
        <p className="incomplete-notice incomplete-notice--missing">
          이 프로젝트의 파일이 유실되었습니다. 포스터, 실행 파일, 스크린샷 등이 등록되지 않은 상태입니다.
        </p>
      )}

      {/* 불완전 안내 (파일은 일부 있지만 불완전 플래그) */}
      {project.isIncomplete && (project.posterUrl || project.gameDownloadUrl || project.video || project.images.length > 0) && (
        <p className="incomplete-notice">
          이 프로젝트는 일부 자료가 누락되었을 수 있습니다.
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
