import type { ExternalLink, Platform, ProjectVideo as VideoInfo, ResponsiveImage } from '@pcu/contracts';
import { ProjectVideo } from './ProjectVideo';
import { ProjectPresentation, type ProjectPresentationData } from './ProjectPresentation';
import { useEffect, useState } from 'react';

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
 saved?: Pick<ProjectPresentationData, 'id' | 'gameDownloadUrl' | 'webglUrl' | 'webglPlayUrl' | 'awards' | 'attachments'>;
	active?: boolean;
	exhibitionLabel?: string;
	onClose: () => void;
}

export type PreviewMediaItem =
	| { kind: 'poster-img'; url: string; label: string; image?: ResponsiveImage }
	| { kind: 'poster-pdf'; name: string; label: string }
	| { kind: 'video-mock'; name: string; label: string }
	| { kind: 'video'; url: string; name: string; label: string; video?: VideoInfo }
	| { kind: 'image'; url: string; label: string; image?: ResponsiveImage }
	| { kind: 'image-pdf'; name: string; label: string };
type MediaItem = PreviewMediaItem;

const isPdfFile = (f: File): boolean =>
	f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');

/**
 * 업로드 전 "작품이 어떻게 보일지" 미리 확인하는 모달.
 * 작성 중인 데이터를 공용 작품 표시 컴포넌트에 전달한다. 로컬 미디어 URL의 수명만 관리한다.
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
		: <video className="project-preview-local-video" src={url} controls preload="metadata" aria-label={name} onError={() => setFailed(true)} />;
}

function ProjectPreview({
	values,
	poster,
	images,
	videos,
	game,
	webgl,
	existingMedia,
 saved,
	active = true,
	exhibitionLabel,
	onClose,
	inline = false,
}: Omit<Props, 'onClose'> & { onClose?: () => void; inline?: boolean }) {
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
			items.push({ kind: 'video', url: URL.createObjectURL(video), name: video.name, label: `동영상${i + 1}` });
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

 const image = (url: string) => ({ original: { url, width: 0, height: 0 }, renditions: [] });
 const savedGame = game && !(game instanceof File) ? saved?.gameDownloadUrl : undefined;
 const savedWebgl = webgl && !(webgl instanceof File) ? saved?.webglUrl : undefined;
 const project: ProjectPresentationData = {
  ...saved,
  id: saved?.id ?? 0,
  title: values.title || '(제목 없음)', summary: values.summary, description: values.description,
  externalLinks: values.externalLinks, platforms: values.platforms ?? [], hardwareRequirements: values.hardwareRequirements,
  members: values.members.filter(m => m.name || m.studentId).map((m, id) => ({ ...m, id })),
  poster: mediaItems.flatMap(m => m.kind === 'poster-img' ? [m.image ?? image(m.url)] : [])[0],
  images: mediaItems.flatMap((m, id) => m.kind === 'image' ? [{ id, kind: 'IMAGE' as const, image: m.image ?? image(m.url) }] : []),
  video: null,
  videos: mediaItems.flatMap((m, id) => m.kind === 'video' ? [m.video ?? { assetId: id, sortOrder: id, role: 'ADDITIONAL' as const, url: m.url, mimeType: 'video/mp4' }] : []),
  gameDownloadUrl: savedGame,
  webglUrl: savedWebgl,
  webglPlayUrl: savedWebgl ? saved?.webglPlayUrl : undefined,
 };
 const unavailable = mediaItems.filter(m => !('url' in m));
 return <ProjectPresentation project={project} inline={inline} active={active} onClose={onClose}
  notice={<>{saved ? '미리보기 — 변경사항은 저장 후 반영됩니다' : '미리보기 — 아직 등록되지 않았습니다'}{exhibitionLabel && <span> · {exhibitionLabel}</span>}{unavailable.map((m, i) => <p key={i}>{'name' in m ? m.name : m.label} — 업로드 처리 후 표시됩니다.</p>)}</>}
  pendingActions={{ game: game && !savedGame ? game.name : undefined, webgl: webgl && !savedWebgl ? webgl.name : undefined }}
  renderVideo={video => video.url?.startsWith('blob:') ? <LocalPreviewVideo key={video.url} url={video.url} name={mediaItems.find(m => m.kind === 'video' && m.url === video.url && m.name)?.label ?? '동영상'} /> : <ProjectVideo video={video} poster={project.poster} title={project.title} />}
 />;
}
