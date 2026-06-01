import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../lib/api';
import { queryKeys } from '../lib/query';
import { LoadingSpinner, ErrorMessage } from '../components/common';
import { useMe } from '../features/auth';
import type { PublicYearItem } from '../contracts';

export default function HomePage() {
	const { isAuthenticated, user } = useMe();
	const canManageProjects = user?.role === 'OPERATOR' || user?.role === 'ADMIN';
	const submitRoute = canManageProjects ? '/admin/projects/new' : '/me/projects/new';

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
								{canManageProjects && (
									<Link to="/admin/projects" className="home-topnav__link">관리</Link>
								)}
								<Link to="/me/projects" className="home-topnav__link">내 작품</Link>
								<Link to={submitRoute} className="home-topnav__btn home-topnav__btn--upload">
									{canManageProjects ? '작품 등록' : '작품 제출'}
								</Link>
								<Link to="/me" className="home-topnav__btn">{user.name}</Link>
							</>
						) : (
							<Link to="/login" className="home-topnav__btn">로그인</Link>
						)}
					</div>
				</div>
			</nav>

			{/* 헤더 — 좌측 상단 제목 */}
			<header className="home-archive-header">
				<div className="container">
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
			</header>

			{/* 전시 그리드 */}
			<section className="home-archive-body">
				<div className="container">
					{yearsLoading && <LoadingSpinner />}
					{yearsError && <ErrorMessage error={yearsError} onReset={yearsRefetch} />}
					{yearsData && <ExhibitionGrid exhibitions={exhibitions} />}
				</div>
			</section>

		</div>
	);
}

// ── 전시 목록 그리드 ──────────────────────────────────────────

function ExhibitionGrid({ exhibitions }: { exhibitions: PublicYearItem[] }) {
	return (
		<div className="home-year-grid">
			{exhibitions.map((ex) => (
				<Link key={ex.id} to={`/exhibitions/${ex.id}`} className="home-year-card">
					<ExhibitionPoster ex={ex} />
					<div className="home-year-card__meta">
						<span className="home-year-card__meta-year">{ex.year}</span>
						<span className="home-year-card__title">{ex.title ?? '전시'}</span>
						<span className="home-year-card__count">{ex.projectCount}개 작품</span>
					</div>
				</Link>
			))}
		</div>
	);
}

function ExhibitionPoster({ ex }: { ex: PublicYearItem }) {
	const [failed, setFailed] = useState(false);
	const showImage = ex.posterUrl && !failed;

	return (
		<div className="home-year-card__poster">
			{showImage ? (
				<img
					src={ex.posterUrl}
					alt={`${ex.title ?? ex.year} 전시회 포스터`}
					onError={() => setFailed(true)}
				/>
			) : (
				<>
					<div className="home-year-card__poster-deco" aria-hidden="true" />
					<div className="home-year-card__poster-text">
						<span className="home-year-card__year">{ex.year}</span>
						<span className="home-year-card__yr-label">학년도</span>
					</div>
				</>
			)}
		</div>
	);
}
