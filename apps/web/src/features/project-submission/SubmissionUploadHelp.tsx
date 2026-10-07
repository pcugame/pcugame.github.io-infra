import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { env } from '../../lib/env';
import { WebglBuildGuideLink } from '../../components/project/WebglBuildGuideLink';

interface HelpStep {
	title: string;
	image: string;
	alt: string;
	description: string;
}

const posterSteps: HelpStep[] = [
	{
		title: '포스터 선택',
		image: 'poster-select.webp',
		alt: '작은 포스터 미리보기 옆의 포스터 선택·교체 버튼',
		description: '포스터 영역의 ‘포스터 선택·교체’를 누르거나 파일을 끌어다 놓으세요. JPG·PNG·WebP·PDF 한 개를 선택할 수 있습니다. 이미지 포스터는 작은 미리보기 아래의 ‘포스터 확대’로 확인할 수 있습니다.',
	},
];
const fileSteps: HelpStep[] = [
	{
		title: '파일 선택',
		image: 'files-select.webp',
		alt: '게임·미디어·자료 영역의 파일 선택 버튼',
		description: '‘게임·미디어·자료’에서 ‘파일 선택’을 누르세요. 여러 파일을 함께 선택하거나 끌어다 놓을 수 있습니다. ‘파일 형식·용량 안내’를 펼치면 제한을 확인할 수 있습니다.',
	},
	{
		title: 'ZIP 용도 선택',
		image: 'zip-purpose.webp',
		alt: '선택한 ZIP 파일 바로 아래의 게임·WebGL·첨부자료 용도 버튼',
		description: '각 ZIP 아래의 버튼으로 용도를 고르세요. 다운로드와 브라우저 실행을 모두 제공하려면 각각의 빌드를 ZIP으로 준비하세요.',
	},
	{
		title: '선택한 파일 확인',
		image: 'files-review.webp',
		alt: '파일명·종류와 선택 취소 버튼이 함께 표시된 파일 목록',
		description: '파일명과 용도를 확인하세요. 잘못 선택했다면 ‘선택 취소’를 누르고 다시 선택하세요.',
	},
	{
		title: '작품 제출',
		image: 'submit-action.webp',
		alt: '화면 하단 작업 바의 작품 제출과 미리보기 버튼',
		description: '작품 정보와 파일을 확인한 뒤 하단 작업 바의 ‘작품 제출’을 누르세요. 운영자 화면에서는 ‘작품 등록’으로 표시됩니다. 버튼을 누를 수 없으면 작업 바의 안내를 확인하세요.',
	},
];

function HelpScreenshot({ step }: { step: HelpStep }) {
	const [enlarged, setEnlarged] = useState(false);
	return (
		<figure>
			<div className={`submission-help-image${enlarged ? ' is-enlarged' : ''}`}>
				<img src={`${env.BASE_PATH}help/project-submission/${step.image}`} alt={step.alt} />
			</div>
			<button type="button" className="btn btn--secondary btn--small submission-help-zoom" aria-pressed={enlarged} onClick={() => setEnlarged(!enlarged)}>
				{enlarged ? '이미지 축소' : '이미지 확대'}
			</button>
			<figcaption>{step.description}</figcaption>
		</figure>
	);
}

function SubmissionHelpModal({ title, steps, webglUploadHint, onClose }: {
	title: string;
	steps: HelpStep[];
	webglUploadHint?: string;
	onClose: () => void;
}) {
	const [stepIndex, setStepIndex] = useState(0);
	const titleId = useId();
	const panel = useRef<HTMLDivElement>(null);
	const closeButton = useRef<HTMLButtonElement>(null);
	const step = steps[stepIndex]!;

	useEffect(() => {
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		closeButton.current?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				onClose();
			} else if (event.key === 'Tab') {
				const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
				const first = buttons[0];
				const last = buttons[buttons.length - 1];
				const outside = !panel.current?.contains(document.activeElement);
				if (event.shiftKey && (document.activeElement === first || outside)) {
					event.preventDefault();
					last?.focus();
				} else if (!event.shiftKey && (document.activeElement === last || outside)) {
					event.preventDefault();
					first?.focus();
				}
			}
		};
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('keydown', onKeyDown);
			document.body.style.overflow = previousOverflow;
			previousFocus?.focus();
		};
	}, [onClose]);

	return createPortal(
		<div className="modal-overlay submission-help-overlay" onClick={(event) => {
			if (event.target === event.currentTarget) onClose();
		}}>
			<div ref={panel} className="modal-panel submission-help-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
				<button ref={closeButton} type="button" className="modal-close" onClick={onClose} aria-label="도움말 닫기">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
						<path d="m18 6-12 12M6 6l12 12" />
					</svg>
				</button>
				<div className="modal-body">
					<h2 id={titleId} className="modal-title">{title}</h2>
					{steps.length > 1 && (
						<nav className="submission-help-steps" aria-label="파일 업로드 안내 단계">
							{steps.map((item, index) => (
								<button key={item.title} type="button" aria-current={index === stepIndex ? 'step' : undefined}
									onClick={() => setStepIndex(index)} aria-label={`${index + 1}단계: ${item.title}`}>
									<span>{index + 1}</span>{item.title}
								</button>
							))}
						</nav>
					)}
					<section className="submission-help-step" aria-live="polite" aria-atomic="true">
						<h3>{stepIndex + 1}. {step.title}</h3>
						<HelpScreenshot key={step.image} step={step} />
						{stepIndex === 1 && webglUploadHint && (
							<div className="submission-help-zip">
								<dl>
									<div><dt>게임</dt><dd>내려받아 실행할 게임 파일</dd></div>
									<div><dt>WebGL</dt><dd>브라우저에서 플레이할 Unity WebGL 빌드</dd></div>
									<div><dt>첨부자료</dt><dd>소스 코드·참고 자료 등</dd></div>
								</dl>
								<p>{webglUploadHint} index.html 한 개와 Build 폴더를 포함하고 빌드 폴더 구조를 유지하세요.</p>
							</div>
						)}
					</section>
					<div className="submission-help-actions">
						{steps.length > 1 && <>
							<button type="button" className="btn btn--secondary" disabled={stepIndex === 0} onClick={() => setStepIndex(stepIndex - 1)}>이전</button>
							<span>{stepIndex + 1} / {steps.length}</span>
						</>}
						{stepIndex < steps.length - 1
							? <button type="button" className="btn btn--primary" onClick={() => setStepIndex(stepIndex + 1)}>다음</button>
							: <button type="button" className="btn btn--primary" onClick={onClose}>확인</button>}
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}

function SubmissionHelpButton({ title, steps, webglUploadHint }: {
	title: string;
	steps: HelpStep[];
	webglUploadHint?: string;
}) {
	const [open, setOpen] = useState(false);
	const close = useCallback(() => setOpen(false), []);
	return (
		<>
			<button type="button" className="submission-upload-help" aria-label={title} aria-haspopup="dialog" onClick={() => setOpen(true)}>
				사용 방법
			</button>
			{open && <SubmissionHelpModal title={title} steps={steps} webglUploadHint={webglUploadHint} onClose={close} />}
		</>
	);
}

export function SubmissionPosterHelp() {
	return <SubmissionHelpButton title="포스터 사용 방법" steps={posterSteps} />;
}

export function SubmissionFilesHelp({ webglUploadHint }: { webglUploadHint: string }) {
	return <span className="submission-guide-links">
		<SubmissionHelpButton title="파일 업로드 사용 방법" steps={fileSteps} webglUploadHint={webglUploadHint} />
		<WebglBuildGuideLink />
	</span>;
}
