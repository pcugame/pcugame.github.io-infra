import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { LoadingSpinner, ErrorMessage } from '../components/common';
import type { PublicProjectCard, PublicYearItem } from '../contracts';

type ShowcaseTab = 'latest' | 'awards';

const CARD_W = 260;
const GRID_GAP = 24; // 1.5rem
const AUTO_ADVANCE_MS = 5000;

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

  const publishedYears = yearsData?.items ?? [];
  const latestYear = publishedYears[0] ?? null;
  const totalProjects = publishedYears.reduce((sum, y) => sum + y.projectCount, 0);

  // ── 최신 전시 작품 조회 ───────────────────────────────────
  const { data: latestProjectsData } = useQuery({
    queryKey: queryKeys.yearProjects(latestYear?.year ?? 0),
    queryFn: () => publicApi.getYearProjects(latestYear!.year),
    enabled: !!latestYear,
  });

  const latestProjects = latestProjectsData?.items ?? [];

  // ── 쇼케이스 탭 ──────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ShowcaseTab>('latest');

  return (
    <div className="home-landing">

      {/* ── Section 1: Compact Hero + Year Archive ──────────── */}
      <section className="home-hero home-hero--compact">
        <div className="home-hero__bg" aria-hidden="true">
          <div className="home-hero__grid" />
          <div className="home-hero__glow home-hero__glow--1" />
          <div className="home-hero__glow home-hero__glow--2" />
        </div>
        <div className="home-hero__inner container">
          <div className="home-hero__text">
            <p className="home-hero__eyebrow">
              Paichai University · Video Game Engineering
            </p>
            <h1 className="home-hero__title">
              배재대학교 게임공학과<br />
              프로젝트 <span className="home-hero__accent">아카이브</span>
            </h1>
            <p className="home-hero__desc">
              연도를 선택하여 게임공학과 졸업작품을 탐색하세요.
            </p>
          </div>

          {/* Year cards — 히어로 내부에 바로 배치 */}
          <div className="home-hero__years">
            {yearsLoading && <LoadingSpinner />}
            {yearsError && <ErrorMessage error={yearsError} onReset={yearsRefetch} />}

            {yearsData && (
              <YearGrid years={publishedYears} />
            )}
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

      {/* ── Section 3: Showcase Carousel ─────────────────────── */}
      <section className="home-showcase" aria-label="작품 쇼케이스">
        <img
          className="home-showcase__char home-showcase__char--left"
          src="/pcu_game_character_female.webp"
          alt=""
          aria-hidden="true"
          draggable={false}
        />
        <img
          className="home-showcase__char home-showcase__char--right"
          src="/pcu_game_character_male.webp"
          alt=""
          aria-hidden="true"
          draggable={false}
        />
        <div className="container">
          <div className="home-showcase__header">
            <div className="home-showcase__tabs" role="tablist">
              <button
                role="tab"
                aria-selected={activeTab === 'latest'}
                className={`home-showcase__tab ${activeTab === 'latest' ? 'home-showcase__tab--active' : ''}`}
                onClick={() => setActiveTab('latest')}
              >
                {latestYear ? `${latestYear.year} 최신 작품` : '최신 작품'}
              </button>
              <button
                role="tab"
                aria-selected={activeTab === 'awards'}
                className={`home-showcase__tab ${activeTab === 'awards' ? 'home-showcase__tab--active' : ''}`}
                onClick={() => setActiveTab('awards')}
              >
                역대 수상작
              </button>
            </div>
            {activeTab === 'latest' && latestYear && (
              <Link to={`/years/${latestYear.year}`} className="home-showcase__more">
                전체 보기 →
              </Link>
            )}
          </div>

          {activeTab === 'latest' && (
            <ShowcaseSlider
              projects={latestProjects}
              year={latestYear?.year ?? 0}
            />
          )}

          {activeTab === 'awards' && (
            <div className="home-showcase__placeholder">
              <p>수상작 정보가 준비 중입니다.</p>
              <span>추후 업데이트될 예정입니다.</span>
            </div>
          )}
        </div>
      </section>

    </div>
  );
}

// ── 페이지네이션 카드 슬라이더 ────────────────────────────────

/** 컨테이너 너비에서 한 줄에 들어가는 카드 수를 계산 (2~4장) */
function calcCardsPerPage(containerWidth: number): number {
  if (containerWidth <= 0) return 3;
  const cols = Math.floor((containerWidth + GRID_GAP) / (CARD_W + GRID_GAP));
  return Math.min(4, Math.max(2, cols));
}

function ShowcaseSlider({
  projects,
  year,
}: {
  projects: PublicProjectCard[];
  year: number;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [direction, setDirection] = useState<'next' | 'prev'>('next');
  const [animating, setAnimating] = useState(false);
  const [paused, setPaused] = useState(false);
  const [perPage, setPerPage] = useState(3);

  // 그리드 너비 관찰 → 한 페이지 카드 수 동적 계산
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setPerPage(calcCardsPerPage(entry.contentRect.width));
    });
    ro.observe(el);
    setPerPage(calcCardsPerPage(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const totalPages = Math.max(1, Math.ceil(projects.length / perPage));

  // 프로젝트 목록 또는 perPage 변경 시 페이지 보정
  useEffect(() => {
    setPage((prev) => Math.min(prev, totalPages - 1));
  }, [totalPages]);

  const navigate = useCallback((target: number, dir: 'next' | 'prev') => {
    const resolved = ((target % totalPages) + totalPages) % totalPages;
    setDirection(dir);
    setAnimating(true);
    // 잠시 뒤 페이지를 전환하여 exit → enter 느낌
    requestAnimationFrame(() => {
      setPage(resolved);
      // 애니메이션 끝나면 플래그 해제
      setTimeout(() => setAnimating(false), 350);
    });
  }, [totalPages]);

  const goPrev = useCallback(() => navigate(page - 1, 'prev'), [navigate, page]);
  const goNext = useCallback(() => navigate(page + 1, 'next'), [navigate, page]);

  // 자동 넘기기 (호버 시 정지)
  useEffect(() => {
    if (paused || projects.length === 0 || animating) return;
    const id = setInterval(() => navigate(page + 1, 'next'), AUTO_ADVANCE_MS);
    return () => clearInterval(id);
  }, [paused, page, navigate, projects.length, animating]);

  if (projects.length === 0) {
    return (
      <div className="home-showcase__placeholder">
        <p>등록된 작품이 없습니다.</p>
      </div>
    );
  }

  const start = page * perPage;
  const visible = projects.slice(start, start + perPage);

  const slideClass = animating
    ? direction === 'next'
      ? 'home-showcase__grid--enter-next'
      : 'home-showcase__grid--enter-prev'
    : '';

  return (
    <div
      className="home-showcase__slider"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* 좌우 화살표 + 카드 그리드 */}
      <div className="home-showcase__stage">
        <button
          className="home-showcase__arrow home-showcase__arrow--prev"
          onClick={goPrev}
          disabled={animating}
          aria-label="이전 페이지"
        >
          ‹
        </button>

        <div className={`home-showcase__grid ${slideClass}`} ref={gridRef}>
          {visible.map((project) => (
            <Link
              key={project.id}
              to={`/years/${year}/${project.slug}`}
              className="archive-card"
            >
              <div className="archive-card__image">
                {project.posterUrl ? (
                  <img
                    src={project.posterUrl}
                    alt={`${project.title} 포스터`}
                    loading="lazy"
                  />
                ) : (
                  <div className="archive-card__placeholder" aria-hidden="true">
                    <span>{project.title.charAt(0)}</span>
                  </div>
                )}
              </div>
              <div className="archive-card__body">
                <h3 className="archive-card__title">{project.title}</h3>
                {project.summary && (
                  <p className="archive-card__summary">{project.summary}</p>
                )}
                <div className="archive-card__footer">
                  <p className="archive-card__members">
                    {project.members.map((m) => m.name).join(' · ')}
                  </p>
                </div>
              </div>
            </Link>
          ))}
        </div>

        <button
          className="home-showcase__arrow home-showcase__arrow--next"
          onClick={goNext}
          disabled={animating}
          aria-label="다음 페이지"
        >
          ›
        </button>
      </div>

      {/* 점 인디케이터 */}
      {totalPages > 1 && (
        <div className="home-showcase__dots" role="tablist" aria-label="페이지 선택">
          {Array.from({ length: totalPages }, (_, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === page}
              aria-label={`${i + 1}페이지`}
              className={`home-showcase__dot ${i === page ? 'home-showcase__dot--active' : ''}`}
              onClick={() => navigate(i, i > page ? 'next' : 'prev')}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 연도 목록 (6개 고정 높이, 초과 시 스크롤) ────────────────

const VISIBLE_YEARS = 6;

function YearGrid({ years }: { years: PublicYearItem[] }) {
  const gridRef = useRef<HTMLDivElement>(null);

  // 6개째 카드 하단까지의 높이를 측정하여 max-height로 고정
  useEffect(() => {
    const el = gridRef.current;
    if (!el || years.length <= VISIBLE_YEARS) return;

    const cards = el.children;
    if (cards.length < VISIBLE_YEARS) return;

    const sixth = cards[VISIBLE_YEARS - 1] as HTMLElement;
    const height = sixth.offsetTop + sixth.offsetHeight;
    el.style.maxHeight = `${height}px`;

    return () => { el.style.maxHeight = ''; };
  }, [years.length]);

  const needsScroll = years.length > VISIBLE_YEARS;

  return (
    <div
      ref={gridRef}
      className={`home-year-grid ${needsScroll ? 'home-year-grid--scrollable' : ''}`}
    >
      {years.map((y) => (
        <Link key={y.id} to={`/years/${y.year}`} className="home-year-card">
          <span className="home-year-card__year">{y.year}</span>
          {y.title && (
            <span className="home-year-card__title">{y.title}</span>
          )}
          <span className="home-year-card__count">
            {y.projectCount}개 작품
          </span>
        </Link>
      ))}
    </div>
  );
}
