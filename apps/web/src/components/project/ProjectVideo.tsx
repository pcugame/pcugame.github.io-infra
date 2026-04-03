import { useState, useRef } from 'react';
import type { ProjectVideo as VideoInfo } from '../../contracts/public';

interface Props {
	video: VideoInfo | null;
	posterUrl?: string;
	title: string;
}

/**
 * NAS 자체 호스팅 영상 재생 컴포넌트.
 * 영상이 없으면 포스터를 표시하고, 포스터도 없으면 null 반환.
 * 재생 오류 시 자연스러운 fallback UI를 보여준다.
 */
export function ProjectVideo({ video, posterUrl, title }: Props) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [hasError, setHasError] = useState(false);

	// 영상도 포스터도 없으면 렌더링하지 않음
	if (!video && !posterUrl) return null;

	// 영상 로드 실패 또는 영상 없음 → 포스터 fallback
	if (!video || hasError) {
		if (!posterUrl) return null;
		return (
			<div className="project-video project-video--poster">
				<img src={posterUrl} alt={`${title} 포스터`} />
				{hasError && (
					<p className="project-video__note">영상을 불러올 수 없습니다.</p>
				)}
			</div>
		);
	}

	return (
		<div className="project-video">
			<video
				ref={videoRef}
				controls
				preload="metadata"
				poster={posterUrl}
				onError={() => setHasError(true)}
			>
				<source src={video.url} type={video.mimeType} />
				브라우저가 영상 재생을 지원하지 않습니다.
			</video>
		</div>
	);
}
