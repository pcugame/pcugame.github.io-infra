import { useEffect, useRef, useState, useCallback } from 'react';

interface PreviewMember {
	name: string;
	studentId: string;
}

interface PreviewValues {
	title: string;
	summary?: string;
	description?: string;
	members: PreviewMember[];
}

interface Props {
	values: PreviewValues;
	poster: File | null;
	images: File[];
	video: File | null;
	game: File | null;
	exhibitionLabel?: string;
	onClose: () => void;
}

type MediaItem =
	| { kind: 'poster-img'; url: string; label: string }
	| { kind: 'poster-pdf'; name: string; label: string }
	| { kind: 'video-mock'; name: string; label: string }
	| { kind: 'image'; url: string; label: string };

const isPdfFile = (f: File): boolean =>
	f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');

/**
 * 업로드 전 "작품이 어떻게 보일지" 미리 확인하는 모달.
 * 포스터·사진은 ObjectURL로 실제 렌더링하고, 영상·게임 파일은 파일명만 목업으로 표시한다.
 */
export function ProjectPreviewModal({
	values,
	poster,
	images,
	video,
	game,
	exhibitionLabel,
	onClose,
}: Props) {
	const overlayRef = useRef<HTMLDivElement>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

	// ObjectURL은 모달이 떠 있는 동안만 유효하면 되므로 마운트 시 1회 생성·언마운트 시 해제한다.
	const [mediaItems] = useState<MediaItem[]>(() => {
		const items: MediaItem[] = [];
		if (poster) {
			if (isPdfFile(poster)) {
				items.push({ kind: 'poster-pdf', name: poster.name, label: '포스터(PDF)' });
			} else {
				items.push({ kind: 'poster-img', url: URL.createObjectURL(poster), label: '포스터' });
			}
		}
		if (video) {
			items.push({ kind: 'video-mock', name: video.name, label: '동영상' });
		}
		images.forEach((f, i) => {
			items.push({ kind: 'image', url: URL.createObjectURL(f), label: `사진 ${i + 1}` });
		});
		return items;
	});

	useEffect(() => {
		return () => {
			for (const item of mediaItems) {
				if (item.kind === 'poster-img' || item.kind === 'image') {
					URL.revokeObjectURL(item.url);
				}
			}
		};
	}, [mediaItems]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (lightboxUrl) setLightboxUrl(null);
			else onClose();
		};
		document.addEventListener('keydown', onKey);
		document.body.style.overflow = 'hidden';
		return () => {
			document.removeEventListener('keydown', onKey);
			document.body.style.overflow = '';
		};
	}, [onClose, lightboxUrl]);

	const handleOverlayClick = (e: React.MouseEvent) => {
		if (e.target === overlayRef.current) onClose();
	};

	const closeLightbox = useCallback((e: React.MouseEvent) => {
		if (e.target === e.currentTarget) setLightboxUrl(null);
	}, []);

	const safeIndex =
		mediaItems.length > 0 ? Math.min(activeIndex, mediaItems.length - 1) : 0;
	const current = mediaItems[safeIndex] ?? null;

	const visibleMembers = values.members.filter((m) => m.name || m.studentId);

	return (
		<div className="modal-overlay" ref={overlayRef} onClick={handleOverlayClick}>
			<div className="modal-panel" role="dialog" aria-modal="true" aria-label="작품 미리보기">
				<button className="modal-close" onClick={onClose} aria-label="닫기">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>

				<div className="preview-banner" role="note">
					미리보기 — 아직 등록되지 않았습니다
				</div>

				{current ? (
					<div className="modal-visual">
						<div className="modal-visual__frame">
							{current.kind === 'poster-img' || current.kind === 'image' ? (
								<>
									<img src={current.url} alt={current.label} className="modal-visual__img" />
									<button
										className="modal-visual__zoom"
										onClick={() => setLightboxUrl(current.url)}
										aria-label="확대해서 보기"
									>
										<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<circle cx="11" cy="11" r="8" />
											<line x1="21" y1="21" x2="16.65" y2="16.65" />
											<line x1="11" y1="8" x2="11" y2="14" />
											<line x1="8" y1="11" x2="14" y2="11" />
										</svg>
									</button>
								</>
							) : current.kind === 'poster-pdf' ? (
								<div className="preview-mock">
									<div className="preview-mock__tag">PDF</div>
									<div className="preview-mock__name">{current.name}</div>
									<div className="preview-mock__note">
										PDF는 첫 페이지가 WEBP로 자동 변환됩니다 (미리보기에서는 파일명만 표시)
									</div>
								</div>
							) : (
								<div className="preview-mock">
									<div className="preview-mock__tag preview-mock__tag--video">
										<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
											<polygon points="5 3 19 12 5 21 5 3" />
										</svg>
									</div>
									<div className="preview-mock__name">{current.name}</div>
									<div className="preview-mock__note">
										영상은 재생되지 않고 파일명만 표시됩니다
									</div>
								</div>
							)}
						</div>
					</div>
				) : (
					<div className="modal-visual">
						<div className="modal-visual__frame">
							<div className="preview-mock preview-mock--empty">
								<div className="preview-mock__note">
									첨부된 미디어가 없습니다. 포스터·사진·영상이 있으면 여기에 표시됩니다.
								</div>
							</div>
						</div>
					</div>
				)}

				{mediaItems.length > 1 && (
					<div className="modal-media-tabs">
						{mediaItems.map((item, i) => (
							<button
								key={`${item.kind}-${i}`}
								type="button"
								className={`modal-media-tab ${i === safeIndex ? 'modal-media-tab--active' : ''}`}
								onClick={() => setActiveIndex(i)}
							>
								{item.kind === 'image' || item.kind === 'poster-img' ? (
									<img
										src={item.url}
										alt={item.label}
										className="modal-media-tab__thumb"
										loading="lazy"
									/>
								) : (
									<span className="modal-media-tab__icon">
										{item.kind === 'video-mock' ? (
											<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
												<polygon points="5 3 19 12 5 21 5 3" />
											</svg>
										) : (
											<span className="preview-tab-pdf">PDF</span>
										)}
									</span>
								)}
								<span className="modal-media-tab__label">{item.label}</span>
							</button>
						))}
					</div>
				)}

				<div className="modal-body">
					<h1 className="modal-title">{values.title || '(제목 없음)'}</h1>

					{exhibitionLabel && (
						<p className="preview-exhibition">{exhibitionLabel}</p>
					)}

					{visibleMembers.length > 0 && (
						<div className="modal-members">
							{visibleMembers.map((m, i) => (
								<span key={i} className="modal-member">
									{m.name || '(이름 미입력)'}
									<span className="modal-member__id">{m.studentId || '(학번 미입력)'}</span>
								</span>
							))}
						</div>
					)}

					{values.summary && <p className="modal-summary">{values.summary}</p>}

					{values.description && (
						<div className="modal-description">
							<div className="prose">{values.description}</div>
						</div>
					)}

					{game && (
						<div className="modal-download">
							<button
								type="button"
								className="btn btn--primary btn--large preview-download-mock"
								disabled
								aria-disabled="true"
							>
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
									<polyline points="7 10 12 15 17 10" />
									<line x1="12" y1="15" x2="12" y2="3" />
								</svg>
								게임 다운로드 (ZIP)
							</button>
							<p className="modal-download__note">
								파일명: {game.name} — 미리보기에서는 다운로드되지 않습니다
							</p>
						</div>
					)}
				</div>
			</div>

			{lightboxUrl && (
				<div className="modal-lightbox" onClick={closeLightbox}>
					<button
						className="modal-lightbox__close"
						onClick={() => setLightboxUrl(null)}
						aria-label="닫기"
					>
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
					<img src={lightboxUrl} alt="확대 이미지" className="modal-lightbox__img" />
				</div>
			)}
		</div>
	);
}
