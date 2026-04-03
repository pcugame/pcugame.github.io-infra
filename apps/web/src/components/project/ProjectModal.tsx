import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { LoadingSpinner } from '../common';
import { ProjectVideo } from './ProjectVideo';

interface Props {
	slug: string;
	year: number;
	onClose: () => void;
}

export function ProjectModal({ slug, year, onClose }: Props) {
	const overlayRef = useRef<HTMLDivElement>(null);

	const { data: project, isLoading } = useQuery({
		queryKey: queryKeys.projectDetail(year, slug),
		queryFn: () => publicApi.getProjectDetail(slug, year),
		enabled: !!slug,
	});

	// ESC 닫기
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		document.addEventListener('keydown', onKey);
		document.body.style.overflow = 'hidden';
		return () => {
			document.removeEventListener('keydown', onKey);
			document.body.style.overflow = '';
		};
	}, [onClose]);

	// 오버레이 클릭 닫기
	const handleOverlayClick = (e: React.MouseEvent) => {
		if (e.target === overlayRef.current) onClose();
	};

	const galleryImages = project?.images.filter((img) => img.kind === 'IMAGE') ?? [];

	return (
		<div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
			<div className="modal-panel" role="dialog" aria-modal="true">
				{/* 닫기 버튼 */}
				<button className="modal-close" onClick={onClose} aria-label="닫기">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>

				{isLoading && (
					<div className="modal-loading">
						<LoadingSpinner />
					</div>
				)}

				{project && (
					<>
						{/* 영상 or 포스터 (상단 비주얼) */}
						{(project.video || project.posterUrl) ? (
							<div className="modal-visual">
								{project.video ? (
									<ProjectVideo
										video={project.video}
										posterUrl={project.posterUrl}
										title={project.title}
									/>
								) : project.posterUrl ? (
									<img src={project.posterUrl} alt={`${project.title} 포스터`} className="modal-poster" />
								) : null}
							</div>
						) : null}

						{/* 본문 */}
						<div className="modal-body">
							<h1 className="modal-title">
								{project.title}
								{project.isLegacy && (
									<span className="legacy-badge" title="아카이브 자료">
										아카이브
									</span>
								)}
							</h1>

							{/* Legacy 안내 */}
							{project.isLegacy && (
								<p className="legacy-notice">
									아카이브 자료입니다. 일부 자료가 누락되었을 수 있습니다.
								</p>
							)}

							{/* 참여 학생 */}
							<div className="modal-members">
								{project.members.map((m) => (
									<span key={m.id} className="modal-member">
										{m.name}
										<span className="modal-member__id">{m.studentId}</span>
									</span>
								))}
							</div>

							{/* 요약 */}
							{project.summary && (
								<p className="modal-summary">{project.summary}</p>
							)}

							{/* 상세 설명 */}
							{project.description && (
								<div className="modal-description">
									<div className="prose">{project.description}</div>
								</div>
							)}

							{/* 스크린샷 갤러리 */}
							{galleryImages.length > 0 && (
								<div className="modal-gallery">
									{galleryImages.map((img) => (
										<img key={img.id} src={img.url} alt="스크린샷" loading="lazy" />
									))}
								</div>
							)}

							{/* 다운로드 */}
							{project.gameDownloadUrl && project.downloadPolicy !== 'NONE' && (
								<div className="modal-download">
									{project.downloadPolicy === 'PUBLIC' ? (
										<a href={project.gameDownloadUrl} className="btn btn--primary btn--large" download>
											<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
												<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
												<polyline points="7 10 12 15 17 10" />
												<line x1="12" y1="15" x2="12" y2="3" />
											</svg>
											게임 다운로드
										</a>
									) : project.downloadPolicy === 'SCHOOL_ONLY' ? (
										<p className="modal-download__note">학교 계정으로 로그인한 사용자만 다운로드할 수 있습니다.</p>
									) : (
										<p className="modal-download__note">관리자만 다운로드할 수 있습니다.</p>
									)}
								</div>
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
