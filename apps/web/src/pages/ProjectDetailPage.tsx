import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { toYouTubeEmbedUrl } from '../lib/utils';
import { LoadingSpinner, ErrorMessage } from '../components/common';

export default function ProjectDetailPage() {
  const { year: yearParam, slug, projectId } = useParams<{
    year?: string;
    slug?: string;
    projectId?: string;
  }>();

  const year = yearParam ? Number(yearParam) : undefined;
  const idOrSlug = slug ?? projectId ?? '';

  const { data: project, isLoading, error, refetch } = useQuery({
    queryKey: slug && year
      ? queryKeys.projectDetail(year, slug)
      : queryKeys.projectDetailById(idOrSlug),
    queryFn: () => publicApi.getProjectDetail(idOrSlug, year),
    enabled: !!idOrSlug,
  });

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;
  if (!project) return null;

  const embedUrl = toYouTubeEmbedUrl(project.youtubeUrl);
  const posterImages = project.images.filter((img) => img.kind === 'POSTER');
  const galleryImages = project.images.filter((img) => img.kind === 'IMAGE');

  return (
    <div className="project-detail">
      {/* 뒤로가기 */}
      {year && (
        <Link to={`/years/${year}`} className="back-link">
          &larr; {year}년 목록으로
        </Link>
      )}

      <h1>{project.title}</h1>

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

      {/* YouTube */}
      {embedUrl && (
        <section className="project-detail__video">
          <h3>영상</h3>
          <div className="video-container">
            <iframe
              src={embedUrl}
              title={`${project.title} 영상`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
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
          {posterImages.length > 0 && posterImages.map((img) => (
            <img key={img.id} src={img.url} alt="포스터" loading="lazy" className="gallery-poster" />
          ))}
        </section>
      )}

      {/* 게임 다운로드 */}
      {project.gameDownloadUrl && project.downloadPolicy !== 'NONE' && (
        <section className="project-detail__download">
          <h3>게임 다운로드</h3>
          {project.downloadPolicy === 'PUBLIC' ? (
            <a
              href={project.gameDownloadUrl}
              className="btn btn--primary"
              download
            >
              다운로드 (ZIP)
            </a>
          ) : project.downloadPolicy === 'SCHOOL_ONLY' ? (
            <p>학교 계정으로 로그인한 사용자만 다운로드할 수 있습니다.</p>
          ) : (
            <p>관리자만 다운로드할 수 있습니다.</p>
          )}
        </section>
      )}
    </div>
  );
}
