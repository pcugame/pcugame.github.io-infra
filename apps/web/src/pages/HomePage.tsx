import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { LoadingSpinner, ErrorMessage } from '../components/common';
import { useMe } from '../features/auth';
import type { PublicYearItem } from '../contracts';

export default function HomePage() {
	const { isAuthenticated, user } = useMe();

	const {
		data: yearsData,
		isLoading: yearsLoading,
		error: yearsError,
		refetch: yearsRefetch,
	} = useQuery({
		queryKey: queryKeys.publicYears,
		queryFn: publicApi.getYears,
	});

	const exhibitions = yearsData?.items ?? [];

	return (
		<div className="home-landing">

			{/* ── Hero: 전체 화면, topnav 오버레이 포함 ─────────── */}
			<section className="home-hero home-hero--full">
				<div className="home-hero__bg" aria-hidden="true">
					<div className="home-hero__grid" />
					<div className="home-hero__glow home-hero__glow--1" />
					<div className="home-hero__glow home-hero__glow--2" />
				</div>

				{/* 상단 nav — 바 없이 투명하게 오버레이 */}
				<nav className="home-topnav" aria-label="사이트 탐색">
					<div className="home-topnav__inner container">
						<Link to="/" className="home-topnav__logo">
							<img src="/pcu_signature.svg" alt="배재대학교" className="home-topnav__logo-sig" draggable={false} />
							<span className="home-topnav__logo-divider" aria-hidden="true" />
							<span className="home-topnav__logo-dept">소프트웨어공학부<br />게임공학전공</span>
						</Link>
						<div className="home-topnav__actions">
							<Link to="/years" className="home-topnav__link">전시 목록</Link>
							{isAuthenticated && user ? (
								<>
									{(user.role === 'OPERATOR' || user.role === 'ADMIN') && (
										<Link to="/admin/projects" className="home-topnav__link">관리</Link>
									)}
									<Link to="/admin/projects/new" className="home-topnav__btn home-topnav__btn--upload">작품 등록</Link>
									<Link to="/me" className="home-topnav__btn">{user.name}</Link>
								</>
							) : (
								<Link to="/login" className="home-topnav__btn">로그인</Link>
							)}
						</div>
					</div>
				</nav>

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
							전시를 선택하여 게임공학과 작품들을 탐색하세요.
						</p>
					</div>

					{/* Exhibition cards */}
					<div className="home-hero__years">
						{yearsLoading && <LoadingSpinner />}
						{yearsError && <ErrorMessage error={yearsError} onReset={yearsRefetch} />}
						{yearsData && <ExhibitionGrid exhibitions={exhibitions} />}
					</div>
				</div>
			</section>

		</div>
	);
}

// ── 전시 목록 (6개 고정 높이, 초과 시 스크롤) ────────────────

const VISIBLE_CARDS = 7;

function ExhibitionGrid({ exhibitions }: { exhibitions: PublicYearItem[] }) {
	const gridRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = gridRef.current;
		if (!el || exhibitions.length <= VISIBLE_CARDS) return;

		const cards = el.children;
		if (cards.length < VISIBLE_CARDS) return;

		const seventh = cards[VISIBLE_CARDS - 1] as HTMLElement;
		const height = seventh.offsetTop + seventh.offsetHeight;
		el.style.maxHeight = `${height}px`;

		return () => { el.style.maxHeight = ''; };
	}, [exhibitions.length]);

	const needsScroll = exhibitions.length > VISIBLE_CARDS;

	return (
		<div
			ref={gridRef}
			className={`home-year-grid ${needsScroll ? 'home-year-grid--scrollable' : ''}`}
		>
			{exhibitions.map((ex) => (
				<Link key={ex.id} to={`/exhibitions/${ex.id}`} className="home-year-card">
					<span className="home-year-card__year">{ex.year}</span>
					{ex.title && (
						<span className="home-year-card__title">{ex.title}</span>
					)}
					<span className="home-year-card__count">
						{ex.projectCount}개 작품
					</span>
				</Link>
			))}
		</div>
	);
}
