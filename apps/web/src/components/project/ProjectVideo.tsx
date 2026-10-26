import { useState, useRef, useEffect } from 'react';
import { I18nProvider } from '@videojs/react/i18n';
import { Video, VideoPlayer } from '@videojs/react/video';
import '@videojs/react/video/skin.css';
import '@videojs/react/i18n/locales/ko/register';
import type { ProjectVideo as VideoInfo, ResponsiveImage as ResponsiveImageData } from '@pcu/contracts';
import { pickRendition } from '../../lib/responsive-image';
import { ResponsiveImage } from '../common';
import { VideoSkin } from '../videojs/default-video/skin';
import { VideoFrameRateMenu } from './VideoFrameRateMenu';
import { VideoQualityMenu } from './VideoQualityMenu';
import type { VideoPlaybackQuality } from '@pcu/contracts';

interface Props {
	video: VideoInfo | null;
	poster?: ResponsiveImageData;
	title: string;
}

interface PlaybackSnapshot {
	time: number;
	paused: boolean;
	volume: number;
	muted: boolean;
	playbackRate: number;
}

export function ProjectVideo(props: Props) {
	return <ProjectVideoPlayer key={props.video?.assetId ?? props.video?.url ?? 'poster'} {...props} />;
}

function snapshot(element: HTMLVideoElement): PlaybackSnapshot {
	return { time: element.currentTime, paused: element.paused, volume: element.volume,
		muted: element.muted, playbackRate: element.playbackRate };
}

function ProjectVideoPlayer({ video, poster, title }: Props) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [hasError, setHasError] = useState(false);
	const [profile, setProfile] = useState('native');
	const [quality, setQuality] = useState<VideoPlaybackQuality>('max');
	const options = video?.playbacks?.filter(item => item.status === 'READY') ?? [];
	const selected = options.find(item => item.profile === profile && (item.quality ?? 'max') === quality)
		?? options.find(item => item.profile === 'native' && (item.quality ?? 'max') === 'max');
	const activeQuality = selected?.quality ?? 'max';
	const frameRates = options.filter(item => (item.quality ?? 'max') === activeQuality);
	const qualities = options.filter(item => item.profile === (selected?.profile ?? 'native'));
	const url = selected?.url ?? video?.url;
	const previousUrl = useRef(url);
	const pending = useRef<PlaybackSnapshot | null>(null);
	const videoPosterSrc = poster ? pickRendition(poster, 960).url : undefined;

	// Native source children let us snapshot before load(), including capability URL renewals.
	useEffect(() => {
		if (previousUrl.current === url) return;
		previousUrl.current = url;
		const element = videoRef.current;
		if (!element) return;
		pending.current ??= snapshot(element);
		element.load();
	}, [url]);

	function choose(value: string) {
		if (value === (selected?.profile ?? 'native')) return;
		if (videoRef.current) pending.current ??= snapshot(videoRef.current);
		setHasError(false);
		setProfile(value);
	}

	function chooseQuality(value: VideoPlaybackQuality) {
		if (value === activeQuality) return;
		if (videoRef.current) pending.current ??= snapshot(videoRef.current);
		setHasError(false);
		setQuality(value);
	}

	function restore() {
		setHasError(false);
		const element = videoRef.current;
		const state = pending.current;
		if (!element || !state) return;
		pending.current = null;
		element.currentTime = Math.min(state.time, Number.isFinite(element.duration) ? Math.max(0, element.duration - 0.01) : state.time);
		element.volume = state.volume;
		element.muted = state.muted;
		element.playbackRate = state.playbackRate;
		if (!state.paused) void element.play().catch(() => {
			// Mobile browsers may require another tap after a source change.
			// A rejected play request alone does not mean the media failed to load.
			if (element.error) setHasError(true);
		});
	}

	if (!video && !videoPosterSrc) return null;
	if (!url || !video) {
		if (!poster && !video?.originalDownloadUrl) return null;
		return <div className="project-video project-video--poster">
			{poster && <ResponsiveImage image={poster} alt={`${title} 포스터`} sizes="(max-width: 768px) 100vw, 960px" decoding="async" />}
			<p className="project-video__note">
				{video?.playbackStatus === 'FAILED' ? '재생용 영상 변환에 실패했습니다. 원본을 다운로드해 확인할 수 있습니다.' : '재생용 영상이 아직 준비되지 않았습니다.'}
			</p>
			{video?.originalDownloadUrl && <a href={video.originalDownloadUrl} className="btn btn--secondary" download>동영상 원본 다운로드</a>}
		</div>;
	}

	return <div className="project-video project-video--player">
		<div className="project-video__surface" data-ui="unstyled">
			<I18nProvider locale="ko">
				<VideoPlayer poster={videoPosterSrc}>
					<VideoSkin className="project-video__skin" settingsMenuItems={<>
						{qualities.length > 0 && <VideoQualityMenu options={qualities} value={activeQuality} onValueChange={chooseQuality} />}
						{frameRates.length > 1 && <VideoFrameRateMenu options={frameRates} value={selected?.profile ?? 'native'} onValueChange={choose} />}
					</>}>
						<Video ref={videoRef} aria-label={title} playsInline preload="metadata" poster={videoPosterSrc}
							onError={() => setHasError(true)} onLoadedMetadata={restore}
							fallback="브라우저가 영상 재생을 지원하지 않습니다.">
							<source src={url} type={selected?.mimeType ?? video.mimeType} />
						</Video>
					</VideoSkin>
				</VideoPlayer>
			</I18nProvider>
		</div>
		{hasError && <div className="project-video__actions">
			<p className="project-video__note" role="alert">
				영상을 불러올 수 없습니다. {(frameRates.length > 1 || qualities.length > 1) && '낮은 화질 또는 프레임률을 선택해 주세요.'}
			</p>
			{video.originalDownloadUrl && <a href={video.originalDownloadUrl} className="btn btn--secondary" download>동영상 원본 다운로드</a>}
		</div>}
	</div>;
}
