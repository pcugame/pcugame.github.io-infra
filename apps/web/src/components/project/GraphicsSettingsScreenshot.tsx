import { useEffect, useId, useRef, useState } from 'react';
import { env } from '../../lib/env';

type Screenshot = { file: string; caption: string; alt: string; width: number; height: number };

const chromiumExample: Screenshot = {
	file: 'chromium-system.webp',
	width: 1408,
	height: 310,
	caption: 'Chromium 설정 예시 · 브라우저와 버전에 따라 화면이 다를 수 있어요.',
	alt: 'Chromium 시스템 설정의 그래픽 가속 사용 옵션',
};

const screenshots: Record<string, Screenshot | undefined> = {
	chrome: chromiumExample,
	edge: chromiumExample,
	opera: chromiumExample,
	whale: chromiumExample,
	brave: {
		file: 'brave-system.webp',
		width: 1408,
		height: 422,
		caption: 'Brave 설정 화면 · 그래픽 가속 옵션을 확인해 주세요.',
		alt: 'Brave 시스템 설정의 그래픽 가속 사용 옵션',
	},
	firefox: {
		file: 'firefox-performance.png',
		width: 600,
		height: 147,
		caption: 'Firefox 설정 화면 · 하드웨어 가속을 켠 상태예요.',
		alt: 'Firefox 성능 설정에서 권장 성능 설정 사용은 해제되고 하드웨어 가속 사용은 선택된 화면',
	},
};

function EnlargedScreenshot({ screenshot, src, onClose }: { screenshot: Screenshot; src: string; onClose: () => void }) {
	const dialog = useRef<HTMLDialogElement>(null);
	const captionId = useId();
	useEffect(() => {
		const element = dialog.current;
		const previousOverflow = document.body.style.overflow;
		if (element) {
			if (typeof element.showModal === 'function') element.showModal();
			else element.setAttribute('open', '');
		}
		document.body.style.overflow = 'hidden';
		return () => {
			if (typeof element?.close === 'function') element.close();
			else element?.removeAttribute('open');
			document.body.style.overflow = previousOverflow;
		};
	}, []);
	return (
		<dialog className="graphics-screenshot-dialog" ref={dialog} aria-label="브라우저 설정 화면" aria-describedby={captionId}
			onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
			<div className="graphics-screenshot-dialog__header">
				<strong>브라우저 설정 화면</strong>
				<button type="button" onClick={onClose} aria-label="확대 이미지 닫기">×</button>
			</div>
			<div className="graphics-screenshot-dialog__content"><img src={src} alt={screenshot.alt} width={screenshot.width} height={screenshot.height} /></div>
			<p id={captionId}>{screenshot.caption}</p>
		</dialog>
	);
}

function ScreenshotPreview({ screenshot }: { screenshot: Screenshot }) {
	const [expanded, setExpanded] = useState(false);
	const [failed, setFailed] = useState(false);
	const src = `${env.BASE_PATH}help/graphics-acceleration/${screenshot.file}`;
	if (failed) return null;
	return (
		<figure className="graphics-screenshot">
			<button type="button" className="graphics-screenshot__preview" aria-label="설정 화면 크게 보기" onClick={() => setExpanded(true)}>
				<img src={src} alt={screenshot.alt} width={screenshot.width} height={screenshot.height} loading="lazy" onError={() => setFailed(true)} />
				<span>설정 화면 크게 보기 <span aria-hidden="true">⤢</span></span>
			</button>
			<figcaption>{screenshot.caption}</figcaption>
			{expanded && <EnlargedScreenshot screenshot={screenshot} src={src} onClose={() => setExpanded(false)} />}
		</figure>
	);
}

export function GraphicsSettingsScreenshot({ browser }: { browser: string }) {
	const screenshot = screenshots[browser];
	return screenshot ? <ScreenshotPreview key={screenshot.file} screenshot={screenshot} /> : null;
}
