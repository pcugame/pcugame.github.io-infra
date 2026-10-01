import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getWebglDisplayScale } from '../../lib/webgl-display';

/** Keep the game's CSS viewport fixed; only scale its presentation, never its DOM. */
export function WebglViewport({ kind, width, height, children }: {
	kind?: 'fixed' | 'responsive' | 'legacy';
	width?: number | null;
	height?: number | null;
	children: ReactNode;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const [available, setAvailable] = useState({ width: 0, height: 0 });
	const [fullscreen, setFullscreen] = useState(false);
	const [fullscreenError, setFullscreenError] = useState('');
	const configured = kind === 'responsive' || ((kind === 'fixed' || kind === undefined) && !!width && !!height);
	const fixed = configured && kind !== 'responsive' && !!width && !!height;

	useEffect(() => {
		const stage = stageRef.current;
		if (!fixed || !stage || typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry) setAvailable({ width: entry.contentRect.width, height: entry.contentRect.height });
		});
		observer.observe(stage);
		return () => observer.disconnect();
	}, [fixed]);

	useEffect(() => {
		const onFullscreenChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
		document.addEventListener('fullscreenchange', onFullscreenChange);
		return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
	}, []);

	async function toggleFullscreen() {
		setFullscreenError('');
		try {
			if (document.fullscreenElement === rootRef.current) await document.exitFullscreen();
			else await rootRef.current?.requestFullscreen();
		} catch {
			setFullscreenError('전체화면을 전환하지 못했습니다. 브라우저의 전체화면 권한을 확인해 주세요.');
		}
	}

	const scale = fixed ? getWebglDisplayScale(width, height, available.width, available.height, fullscreen) : 1;
	return (
		<div ref={rootRef} className={`project-play-page__frame-wrap${configured ? ` webgl-viewport${fixed ? '' : ' webgl-viewport--responsive'}` : ''}`}>
			{configured && <div className="webgl-viewport__toolbar">
				<span>{fixed ? `기준 표시 크기 ${width} × ${height} CSS px` : '반응형 · 사용 가능한 화면 영역에 맞춤'}</span>
				{typeof document.documentElement.requestFullscreen === 'function' && <button type="button" className="btn btn--secondary btn--small" onClick={toggleFullscreen}>
					{fullscreen ? '전체화면 종료' : '전체화면'}
				</button>}
				{fullscreenError && <span role="alert">{fullscreenError}</span>}
			</div>}
			<div ref={stageRef} className={configured ? 'webgl-viewport__stage' : undefined}>
				<div className={configured ? 'webgl-viewport__surface' : undefined} style={fixed ? {
					width, height, transform: `translate(-50%, -50%) scale(${scale})`,
					visibility: scale > 0 ? 'visible' : 'hidden',
				} : undefined}>
					{children}
				</div>
			</div>
		</div>
	);
}
