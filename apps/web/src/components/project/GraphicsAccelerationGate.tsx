import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { detectGraphicsAcceleration, type GraphicsAccelerationStatus } from '../../lib/graphicsAcceleration';
import { GraphicsAccelerationGuide } from './GraphicsAccelerationGuide';

function AccelerationDialog({ onRetry, onContinue, onCancel, checked }: {
	onRetry: () => void;
	onContinue: () => void;
	onCancel: () => void;
	checked: boolean;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const descriptionId = useId();
	useEffect(() => {
		const element = dialog.current;
		const previousOverflow = document.body.style.overflow;
		const root = document.documentElement;
		const previousRootOverflow = root.style.overflow;
		const previousGutter = root.style.scrollbarGutter;
		if (element) {
			if (typeof element.showModal === 'function') element.showModal();
			else element.setAttribute('open', '');
		}
		document.body.style.overflow = 'hidden';
		root.style.overflow = 'hidden';
		root.style.scrollbarGutter = 'auto';
		return () => {
			if (typeof element?.close === 'function') element.close();
			else element?.removeAttribute('open');
			document.body.style.overflow = previousOverflow;
			root.style.overflow = previousRootOverflow;
			root.style.scrollbarGutter = previousGutter;
		};
	}, []);
	return (
		<dialog ref={dialog} className="graphics-gate" aria-labelledby={titleId} aria-describedby={descriptionId}
			onCancel={(event) => { event.preventDefault(); onCancel(); }}>
			<button type="button" className="graphics-gate__close" aria-label="플레이 취소하고 작품으로 돌아가기" onClick={onCancel}>×</button>
			<div className="graphics-gate__body">
				<div className="graphics-gate__icon" aria-hidden="true">
					<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
						<rect x="4" y="6" width="18" height="11" rx="2" />
						<circle cx="12" cy="11.5" r="3.5" />
						<path d="M12 8v2m3.5 1.5h-2M12 15v-2m-3.5-1.5h2M2 4h2v15H2m6-2v3h8v-3m-5 0v3m3-3v3m4-11h1m-1 3h1" />
					</svg>
				</div>
				<span className="graphics-gate__eyebrow">플레이 준비</span>
				<h2 id={titleId}>그래픽 가속 설정을 확인해 주세요</h2>
				<p id={descriptionId} className="graphics-gate__description">그래픽카드가 쉬고 있을 수 있어요. 그래픽 가속을 켜면 더 부드럽게 플레이할 수 있어요.</p>
				<GraphicsAccelerationGuide />
				<p className="graphics-gate__note">설정이 이미 켜져 있다면 기기나 그래픽 드라이버의 문제일 수 있어요.</p>
				<p className="graphics-gate__result" role="status">{checked ? '아직 그래픽 가속을 확인하지 못했어요. 브라우저를 다시 시작한 후 확인해 주세요.' : ''}</p>
			</div>
			<div className="graphics-gate__footer">
				<button type="button" className="graphics-gate__continue" onClick={onContinue}>그래도 실행</button>
				<button type="button" className="btn btn--primary" onClick={onRetry}>설정 후 다시 확인 <span aria-hidden="true">↻</span></button>
			</div>
		</dialog>
	);
}

export function GraphicsAccelerationGate({ children, projectId }: { children: ReactNode; projectId: number }) {
	const navigate = useNavigate();
	const [status, setStatus] = useState<GraphicsAccelerationStatus | null>(null);
	const [bypassed, setBypassed] = useState(false);
	const [checked, setChecked] = useState(false);
	useEffect(() => {
		let active = true;
		Promise.resolve().then(() => {
			if (active) setStatus(detectGraphicsAcceleration());
		});
		return () => { active = false; };
	}, []);

	if (bypassed || status === 'available' || status === 'unknown') return children;

	return (
		<>
			<div className="graphics-gate__stage" aria-hidden="true"><span>게임 실행 준비 중</span></div>
			{status === null ? <p role="status">게임 실행 환경을 확인하고 있습니다…</p> : (
				<AccelerationDialog checked={checked}
					onRetry={() => { setStatus(detectGraphicsAcceleration()); setChecked(true); }}
					onContinue={() => setBypassed(true)} onCancel={() => navigate(`/projects/${projectId}`)} />
			)}
		</>
	);
}
