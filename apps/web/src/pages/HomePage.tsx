import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { LoadingSpinner, ErrorMessage } from '../components/common';

export default function HomePage() {
  const {
    data: yearsData,
    isLoading: yearsLoading,
    error: yearsError,
    refetch: yearsRefetch,
  } = useQuery({
    queryKey: queryKeys.publicYears,
    queryFn: publicApi.getYears,
  });

  const publishedYears = yearsData?.items.filter((y) => y.isPublished) ?? [];
  const latestYear = publishedYears[0] ?? null;
  const totalProjects = publishedYears.reduce((sum, y) => sum + y.projectCount, 0);

  const { data: latestProjectsData } = useQuery({
    queryKey: queryKeys.yearProjects(latestYear?.year ?? 0),
    queryFn: () => publicApi.getYearProjects(latestYear!.year),
    enabled: !!latestYear,
  });

  const highlightProjects = latestProjectsData?.items.slice(0, 3) ?? [];

  return (
    <div className="home-landing">

      {/* ── Section 1: Hero ───────────────────────────────────── */}
      <section className="home-hero">
        <div className="home-hero__bg" aria-hidden="true">
          <div className="home-hero__grid" />
          <div className="home-hero__glow home-hero__glow--1" />
          <div className="home-hero__glow home-hero__glow--2" />
        </div>
        <div className="home-hero__inner container">
          <div className="home-hero__text">
            <p className="home-hero__eyebrow">
              Paichai University · Game Engineering
            </p>
            <h1 className="home-hero__title">
              우리들의<br />
              게임 프로젝트<br />
              <span className="home-hero__accent">아카이브</span>
            </h1>
            <p className="home-hero__desc">
              배재대학교 게임공학과 학생들의 아름다운 게임들을 만나보세요.
            </p>
            <div className="home-hero__ctas">
              <Link to="/years" className="home-btn home-btn--primary">
                최신 졸업 작품 보러가기
              </Link>
              <a href="#home-about" className="home-btn home-btn--ghost">
                전시 소개 ↓
              </a>
            </div>
          </div>
          <div className="home-hero__characters" aria-hidden="true">
            <div className="home-hero__char home-hero__char--male">
              <img src="/pcu_game_character_male.png" alt="" draggable={false} />
            </div>
            <div className="home-hero__char home-hero__char--female">
              <img src="/pcu_game_character_female.png" alt="" draggable={false} />
            </div>
          </div>
        </div>
      </section>

      {/* ── Section 2: Stats ──────────────────────────────────── */}
      {yearsData && publishedYears.length > 0 && (
        <section className="home-stats" aria-label="전시 통계">
          <div className="container">
            <div className="home-stats__grid">
              <div className="home-stats__item">
                <span className="home-stats__number">{totalProjects}</span>
                <span className="home-stats__label">전체 프로젝트</span>
                <span className="home-stats__sub">지금까지 전시된 모든 작품</span>
              </div>
              <div className="home-stats__divider" aria-hidden="true" />
              <div className="home-stats__item">
                <span className="home-stats__number">{latestYear?.projectCount ?? 0}</span>
                <span className="home-stats__label">올해의 작품</span>
                <span className="home-stats__sub">가장 빛나는 최신 프로젝트</span>
              </div>
              <div className="home-stats__divider" aria-hidden="true" />
              <div className="home-stats__item">
                <span className="home-stats__number">{publishedYears.length}</span>
                <span className="home-stats__label">전시 연도</span>
                <span className="home-stats__sub">쌓아온 기수의 기록</span>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── Section 3: Latest Highlight (dark awards style) ───── */}
      {latestYear && (
        <section className="home-highlight" aria-labelledby="home-highlight-heading">
          <div className="home-highlight__glow" aria-hidden="true" />
          <img
            className="home-highlight__bg-char"
            src="/pcu_game_character_male.png"
            alt=""
            aria-hidden="true"
            draggable={false}
          />
          <div className="home-highlight__inner container">
            <div className="home-section-header--dark">
              <div>
                <p className="home-eyebrow home-eyebrow--gold">
                  {latestYear.year} Graduation Highlights
                </p>
                <h2 id="home-highlight-heading" className="home-section-title home-section-title--dark">
                  최신 전시 하이라이트
                </h2>
              </div>
              <Link
                to={`/years/${latestYear.year}`}
                className="home-link-more home-link-more--gold"
              >
                전체 보기 →
              </Link>
            </div>

            {highlightProjects.length > 0 ? (
              <div className="home-highlight__grid">
                {highlightProjects.map((project) => (
                  <Link
                    key={project.id}
                    to={`/years/${latestYear.year}/${project.slug}`}
                    className="home-highlight-card"
                  >
                    <div className="home-highlight-card__poster">
                      {project.posterUrl ? (
                        <img
                          src={project.posterUrl}
                          alt={`${project.title} 포스터`}
                          loading="lazy"
                        />
                      ) : (
                        <div className="home-highlight-card__no-poster" aria-hidden="true">
                          <span>{project.title.charAt(0)}</span>
                        </div>
                      )}
                    </div>
                    <div className="home-highlight-card__info">
                      <h3 className="home-highlight-card__title">{project.title}</h3>
                      {project.summary && (
                        <p className="home-highlight-card__summary">{project.summary}</p>
                      )}
                      <p className="home-highlight-card__members">
                        {project.members.map((m) => m.name).join(' · ')}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="home-highlight__loading">
                <LoadingSpinner />
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Section 4: Year Archive ───────────────────────────── */}
      <section className="home-archive" aria-labelledby="home-archive-heading">
        <div className="container">
          <div className="home-section-header">
            <div>
              <p className="home-eyebrow">Archive</p>
              <h2 id="home-archive-heading" className="home-section-title">
                연도별 아카이브
              </h2>
            </div>
            <Link to="/years" className="home-link-more">
              전체 연도 →
            </Link>
          </div>

          {yearsLoading && <LoadingSpinner />}
          {yearsError && <ErrorMessage error={yearsError} onReset={yearsRefetch} />}

          {yearsData && (
            <div className="home-archive__grid">
              {publishedYears.map((y, i) => (
                <Link
                  key={y.id}
                  to={`/years/${y.year}`}
                  className="home-archive-card"
                >
                  <span className="home-archive-card__index">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="home-archive-card__main">
                    <span className="home-archive-card__year">{y.year}</span>
                    {y.title && (
                      <span className="home-archive-card__title">{y.title}</span>
                    )}
                  </div>
                  <span className="home-archive-card__count">
                    {y.projectCount}개 작품
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Section 5: About ──────────────────────────────────── */}
      <section
        className="home-about"
        id="home-about"
        aria-labelledby="home-about-heading"
      >
        <div className="container">
          <div className="home-about__grid">
            <div className="home-about__lead">
              <p className="home-eyebrow">About</p>
              <h2 id="home-about-heading" className="home-section-title">
                게임공학과<br />졸업작품 전시
              </h2>
            </div>
            <div className="home-about__items">
              <div className="home-about__item">
                <h3>어떤 작품이 전시되나요?</h3>
                <p>
                  배재대학교 게임공학과 졸업 예정 학생들이 직접 개발한 게임과
                  인터랙티브 미디어 작품이 전시됩니다. 기획부터 개발, 디자인까지
                  학생들이 주도적으로 제작한 창작물입니다.
                </p>
              </div>
              <div className="home-about__item">
                <h3>왜 아카이브가 중요한가요?</h3>
                <p>
                  각 기수의 졸업작품은 그 세대의 기술 역량과 창의성을 담은
                  기록입니다. 이 아카이브는 과거와 현재의 작품을 한 곳에서
                  탐색할 수 있도록 보존합니다.
                </p>
              </div>
              <div className="home-about__item">
                <h3>어떻게 탐색하면 되나요?</h3>
                <p>
                  연도별 아카이브에서 원하는 연도를 선택하면 해당 연도의 모든
                  작품을 볼 수 있습니다. 각 작품 카드를 클릭하면 상세 정보,
                  팀원, 플레이 영상을 확인할 수 있습니다.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Section 6: Bottom CTA ─────────────────────────────── */}
      <section className="home-cta" aria-label="작품 탐색 유도">
        <div className="home-cta__bg-pattern" aria-hidden="true" />
        <div className="container">
          <div className="home-cta__inner">
            <p className="home-eyebrow home-eyebrow--dim">Ready to explore?</p>
            <h2 className="home-cta__title">지금 바로 탐색해보세요</h2>
            <p className="home-cta__desc">
              연도별로 정리된 졸업작품 아카이브를 둘러보세요.
            </p>
            <Link to="/years" className="home-btn home-btn--white home-btn--large">
              전체 연도 보기
            </Link>
          </div>
        </div>
      </section>

    </div>
  );
}
