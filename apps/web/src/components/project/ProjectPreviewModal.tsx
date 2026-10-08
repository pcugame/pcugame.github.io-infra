import type { ExternalLink, Platform } from '@pcu/contracts';
import { createPortal } from 'react-dom';
import { ProjectPublicMeta } from './ProjectPublicMeta';
import { useEffect, useRef, useState, useCallback } from 'react';

interface PreviewMember {
	name: string;
	studentId: string;
}

interface PreviewValues {
	externalLinks?: ExternalLink[];
	platforms?: Platform[];
	hardwareRequirements?: string;
	title: string;
	summary?: string;
	description?: string;
	members: PreviewMember[];
}

interface Props {
	values: PreviewValues;
	poster: File | null;
	images: File[];
	videos: File[];
	game: Pick<File, 'name'> | null;
	webgl?: Pick<File, 'name'> | null;
	existingMedia?: PreviewMediaItem[];
	active?: boolean;
	exhibitionLabel?: string;
	onClose: () => void;
}

export type PreviewMediaItem =
	| { kind: 'poster-img'; url: string; label: string }
	| { kind: 'poster-pdf'; name: string; label: string }
	| { kind: 'video-mock'; name: string; label: string }
	| { kind: 'video'; url: string; name: string; label: string }
	| { kind: 'image'; url: string; label: string }
	| { kind: 'image-pdf'; name: string; label: string };
type MediaItem = PreviewMediaItem;

const isPdfFile = (f: File): boolean =>
	f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');

/**
 * 업로드 전 "작품이 어떻게 보일지" 미리 확인하는 모달.
 * 포스터·사진은 ObjectURL로 실제 렌더링하고, 영상·게임 파일은 파일명만 목업으로 표시한다.
 */
export function ProjectPreviewModal(props: Props) {
	return <ProjectPreview {...props} />;
}

/** Embedded preview retains local media while navigating between studio steps. */
export function ProjectPreviewPanel(props: Omit<Props, 'onClose'>) {
	return <ProjectPreview {...props} inline />;
}

function LocalPreviewVideo({ url, name }: { url: string; name: string }) {
	const [failed, setFailed] = useState(false);
	return failed ? <div className="preview-mock"><p>{name}</p><p>이 브라우저에서 미리 재생할 수 없는 영상입니다. 업로드 후 재생용 영상으로 변환됩니다.</p></div>
		: <video className="modal-visual__img" src={url} controls preload="metadata" aria-label={name} onError={() => setFailed(true)} />;
}

function ProjectPreview({
	values,
	poster,
	images,
	videos,
	game,
	webgl,
	existingMedia,
	active = true,
	exhibitionLabel,
	onClose,
	inline = false,
}: Omit<Props, 'onClose'> & { onClose?: () => void; inline?: boolean }) {
	const overlayRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!active) overlayRef.current?.querySelectorAll('video').forEach(video => video.pause());
	}, [active]);
	const [activeIndex, setActiveIndex] = useState(0);
	const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

	const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
	// Blob URLs are external resources: create and release them in the same effect,
	// including React StrictMode's setup/cleanup/setup cycle.
	useEffect(() => {
		const items: MediaItem[] = [];
		if (poster) {
			if (isPdfFile(poster)) {
				items.push({ kind: 'poster-pdf', name: poster.name, label: '포스터(PDF)' });
			} else {
				items.push({ kind: 'poster-img', url: URL.createObjectURL(poster), label: '포스터' });
			}
		}
		videos.forEach((video, i) => {
			items.push(inline ? { kind: 'video', url: URL.createObjectURL(video), name: video.name, label: `동영상${i + 1}` } : { kind: 'video-mock', name: video.name, label: `동영상${i + 1}` });
		});
		images.forEach((f, i) => {
			if (isPdfFile(f)) {
				items.push({ kind: 'image-pdf', name: f.name, label: `사진 ${i + 1}(PDF)` });
			} else {
				items.push({ kind: 'image', url: URL.createObjectURL(f), label: `사진 ${i + 1}` });
			}
		});
		// eslint-disable-next-line react-hooks/set-state-in-effect -- Publish effect-owned blob URLs; render-time allocation leaks under StrictMode.
		setMediaItems([...items, ...(existingMedia ?? []).filter(item => !poster || item.kind !== 'poster-img')]);
		return () => {
			for (const item of items) {
				if ('url' in item) {
					URL.revokeObjectURL(item.url);
				}
			}
		};
	}, [poster, images, videos, inline, existingMedia]);

	useEffect(() => {
		if (inline && !lightboxUrl) return;
		const previousOverflow = document.body.style.overflow;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (lightboxUrl) setLightboxUrl(null);
			else onClose?.();
		};
		document.addEventListener('keydown', onKey);
		document.body.style.overflow = 'hidden';
		return () => {
			document.removeEventListener('keydown', onKey);
			document.body.style.overflow = previousOverflow;
		};
	}, [onClose, lightboxUrl, inline]);

	const handleOverlayClick = (e: React.MouseEvent) => {
		if (!inline && e.target === overlayRef.current) onClose?.();
	};

	const closeLightbox = useCallback((e: React.MouseEvent) => {
		if (e.target === e.currentTarget) setLightboxUrl(null);
	}, []);

	const safeIndex =
		mediaItems.length > 0 ? Math.min(activeIndex, mediaItems.length - 1) : 0;
	const current = mediaItems[safeIndex] ?? null;

	const visibleMembers = values.members.filter((m) => m.name || m.studentId);

	return (
		<div className={inline ? "project-preview-inline" : "modal-overlay"} ref={overlayRef} onClick={handleOverlayClick}>
			<div className={inline ? "project-preview-inline__content" : "modal-panel"} role={inline ? "region" : "dialog"} tabIndex={inline ? 0 : undefined} aria-modal={inline ? undefined : true} aria-label={inline ? "전시 화면 미리보기" : "작품 미리보기"}>
				{!inline && <button type="button" className="modal-close" onClick={onClose} aria-label="닫기">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>}

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
										type="button"
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
							) : current.kind === 'video' ? (<LocalPreviewVideo key={current.url} url={current.url} name={current.name} />) : current.kind === 'poster-pdf' || current.kind === 'image-pdf' ? (
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
										{item.kind === 'video-mock' || item.kind === 'video' ? (
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
					{inline ? <h2 className="modal-title">{values.title || '(제목 없음)'}</h2> : <h1 className="modal-title">{values.title || '(제목 없음)'}</h1>}
					<ProjectPublicMeta externalLinks={values.externalLinks} platforms={values.platforms} hardwareRequirements={values.hardwareRequirements} />

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

					{webgl && <div className="modal-download"><button type="button" className="btn btn--primary btn--large" disabled>게임 실행</button><p className="modal-download__note">{webgl.name} — 웹 빌드는 업로드 후 실행할 수 있습니다.</p></div>}
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

			{lightboxUrl && createPortal(
				<div className="modal-lightbox" onClick={closeLightbox}>
					<button
						type="button"
						className="modal-lightbox__close"
						onClick={() => setLightboxUrl(null)}
						aria-label="닫기"
					>
						<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
					<img src={lightboxUrl} alt="확대 이미지" className="modal-lightbox__img" />
				</div>, document.body
			)}
		</div>
	);
}
