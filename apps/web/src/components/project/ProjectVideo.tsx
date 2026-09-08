import { useState, useRef } from 'react';
import type {
	ProjectVideo as VideoInfo,
	ResponsiveImage as ResponsiveImageData,
} from '@pcu/contracts';
import { pickRendition } from '../../lib/responsive-image';
import { ResponsiveImage } from '../common';

interface Props {
	video: VideoInfo | null;
	poster?: ResponsiveImageData;
	title: string;
}

/**
 * 영상 재생 컴포넌트.
 * 영상이 없으면 포스터를 표시하고, 포스터도 없으면 null 반환.
 * 재생 오류 시 자연스러운 fallback UI를 보여준다.
 */
export function ProjectVideo({ video, poster, title }: Props) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [hasError, setHasError] = useState(false);
	const videoPosterSrc = poster ? pickRendition(poster, 960).url : undefined;

	// 영상 metadata도 포스터도 없으면 렌더링하지 않음
	if (!video && !videoPosterSrc) return null;

	// Playback 생성 실패/대기 또는 로드 실패 시 원본 다운로드 capability는 유지한다.
	if (!video?.url || hasError) {
		if (!poster && !video?.originalDownloadUrl) return null;
		return (
			<div className="project-video project-video--poster">
				{poster && (
					<ResponsiveImage
						image={poster}
						alt={`${title} 포스터`}
						sizes="(max-width: 768px) 100vw, 960px"
						decoding="async"
					/>
				)}
				<p className="project-video__note">
					{hasError ? '영상을 불러올 수 없습니다.' : '재생용 영상이 아직 준비되지 않았습니다.'}
				</p>
				{video?.originalDownloadUrl && (
					<a href={video.originalDownloadUrl} className="btn btn--secondary" download>
						동영상 원본 다운로드
					</a>
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
				poster={videoPosterSrc}
				onError={() => setHasError(true)}
			>
				<source src={video.url} type={video.mimeType} />
				브라우저가 영상 재생을 지원하지 않습니다.
			</video>
			{video.originalDownloadUrl && (
				<a href={video.originalDownloadUrl} className="btn btn--secondary" download>
					동영상 원본 다운로드
				</a>
			)}
		</div>
	);
}
