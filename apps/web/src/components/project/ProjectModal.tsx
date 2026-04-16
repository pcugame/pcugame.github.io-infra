import { useEffect, useRef, useState } from 'react';
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

type MediaItem =
	| { type: 'video'; url: string; mimeType: string; label: string }
	| { type: 'poster'; url: string; label: string }
	| { type: 'image'; id: number; url: string; label: string };

export function ProjectModal({ slug, year, onClose }: Props) {
	const overlayRef = useRef<HTMLDivElement>(null);
	const [activeIndex, setActiveIndex] = useState(0);

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

	// 미디어 목록 구성
	const mediaItems: MediaItem[] = [];
	if (project) {
		if (project.video) {
			mediaItems.push({
				type: 'video',
				url: project.video.url,
				mimeType: project.video.mimeType,
				label: '동영상',
			});
		}
		if (project.posterUrl) {
			mediaItems.push({
				type: 'poster',
				url: project.posterUrl,
				label: '포스터',
			});
		}
		const galleryImages = project.images.filter((img) => img.kind === 'IMAGE');
		galleryImages.forEach((img, i) => {
			mediaItems.push({
				type: 'image',
				id: img.id,
				url: img.url,
				label: `사진 ${i + 1}`,
			});
		});
	}

	const current = mediaItems[activeIndex] ?? null;

	// activeIndex가 범위를 벗어나지 않도록
	const safeIndex = Math.min(activeIndex, Math.max(mediaItems.length - 1, 0));
	if (safeIndex !== activeIndex && mediaItems.length > 0) {
		setActiveIndex(safeIndex);
	}

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
						{/* 메인 미디어 표시 */}
						{current && (
							<div className="modal-visual">
								{current.type === 'video' ? (
									<ProjectVideo
										video={{ url: current.url, mimeType: current.mimeType }}
										posterUrl={project.posterUrl}
										title={project.title}
									/>
								) : (
									<img
										src={current.url}
										alt={current.label}
										className="modal-poster"
									/>
								)}
							</div>
						)}

						{/* 미디어 탭 목록 */}
						{mediaItems.length > 1 && (
							<div className="modal-media-tabs">
								{mediaItems.map((item, i) => (
									<button
										key={item.type === 'image' ? `img-${item.id}` : item.type}
										className={`modal-media-tab ${i === activeIndex ? 'modal-media-tab--active' : ''}`}
										onClick={() => setActiveIndex(i)}
									>
										{item.type === 'video' ? (
											<span className="modal-media-tab__icon">
												<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
													<polygon points="5 3 19 12 5 21 5 3" />
												</svg>
											</span>
										) : (
											<img
												src={item.url}
												alt={item.label}
												className="modal-media-tab__thumb"
												loading="lazy"
											/>
										)}
										<span className="modal-media-tab__label">{item.label}</span>
									</button>
								))}
							</div>
						)}

						{/* 본문 */}
						<div className="modal-body">
							<h1 className="modal-title">
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
									이 프로젝트의 파일이 유실되었습니다.
								</p>
							)}

							{/* 불완전 안내 */}
							{project.isIncomplete && (project.posterUrl || project.gameDownloadUrl || project.video || project.images.length > 0) && (
								<p className="incomplete-notice">
									일부 자료가 누락되었을 수 있습니다.
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

							{/* 다운로드 — GAME files are always publicly downloadable */}
							{project.gameDownloadUrl && (
								<div className="modal-download">
									<a href={project.gameDownloadUrl} className="btn btn--primary btn--large" download>
										<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
											<polyline points="7 10 12 15 17 10" />
											<line x1="12" y1="15" x2="12" y2="3" />
										</svg>
										게임 다운로드
									</a>
								</div>
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
