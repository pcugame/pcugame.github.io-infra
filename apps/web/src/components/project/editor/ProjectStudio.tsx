import { useId, useRef, useState, type ReactNode } from 'react';

const projectStudioSteps = [
	{ title: '작품 소개', description: '전시 페이지에 표시할 기본 정보를 작성하세요.' },
	{ title: '게임 정보', description: '실행 환경과 참여 학생, 외부 링크를 작성하세요.' },
	{ title: '파일 업로드', description: '포스터와 게임 빌드, 영상·사진을 선택하세요.' },
	{ title: '미리보기', description: '전시 화면을 확인하세요.' },
];

/** Panels stay mounted so drafts, selected files and upload owners survive navigation. */
export function ProjectStudio({ title, secondaryAction, step, onStepChange, disabled, notice,
	panels, preview, feedback, actions, renderBody = body => body, before, after }: {
	title: ReactNode; secondaryAction?: ReactNode; step: number; onStepChange: (step: number) => void;
	disabled: boolean; notice?: string; panels: ReactNode[]; preview: ReactNode;
	feedback?: ReactNode; actions: ReactNode; renderBody?: (body: ReactNode) => ReactNode;
	before?: ReactNode; after?: ReactNode;
}) {
	const id = useId();
	const sheet = useRef<HTMLDivElement>(null);
	const [direction, setDirection] = useState('forward');
	const changeStep = (next: number) => {
		setDirection(next < step ? 'backward' : 'forward');
		onStepChange(next);
		requestAnimationFrame(() => {
			sheet.current?.querySelector<HTMLElement>(`[data-studio-step="${next}"] h2`)?.focus({ preventScroll: true });
			const top = sheet.current?.getBoundingClientRect().top;
			if (top !== undefined && (top < 0 || top > window.innerHeight - 80)) sheet.current?.scrollIntoView({ behavior: 'instant', block: 'start' });
		});
	};
	const body = <div className="submission-studio__body">
		{projectStudioSteps.map((item, index) => <section key={item.title} data-studio-step={index} hidden={step !== index} inert={step !== index} aria-labelledby={`${id}-${index}`}>
			<div className="submission-studio__sheet-heading"><div><div className="submission-studio__sheet-title"><h2 id={`${id}-${index}`} tabIndex={-1}>{item.title}</h2>{step === index && notice && <span className="field-error" role="alert">{notice}</span>}</div><p>{item.description}</p></div><span>0{index + 1} / 04</span></div>
			<div className="submission-studio__fields">{panels[index]}</div>
		</section>)}
		<div className="submission-studio__feedback" aria-live="polite">{feedback}</div>
		<footer className="submission-studio__actions">{actions}</footer>
	</div>;
	return <div className="submission-studio">
		<header className="admin-page-header submission-studio__header"><div className="admin-page-header__text"><h1>{title}</h1></div>{secondaryAction}</header>
		{before}
		<div className="submission-studio__layout">
			<nav className="submission-studio__rail" aria-label="작품 작성 단계">
				{projectStudioSteps.map((item, index) => <button key={item.title} type="button" className={`submission-studio__step${step === index ? ' is-active' : ''}`} aria-current={step === index ? 'step' : undefined} disabled={disabled} onClick={() => changeStep(index)}><span>{index + 1}</span>{item.title}</button>)}
			</nav>
			<div className="submission-studio__stage" data-step-direction={direction}>
				<button type="button" className="submission-studio__arrow submission-studio__arrow--previous" aria-label="이전 작성 단계" disabled={step === 0 || disabled} onClick={() => changeStep(step - 1)}><svg aria-hidden="true" viewBox="0 0 24 32" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 4 7 16 17 28" /></svg></button>
				<button type="button" className="submission-studio__arrow submission-studio__arrow--next" aria-label="다음 작성 단계" title="다음 단계" disabled={step === 3 || disabled} onClick={() => changeStep(step + 1)}><svg aria-hidden="true" viewBox="0 0 24 32" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4 17 16 7 28" /></svg></button>
				<div className="submission-studio__sheet" ref={sheet}>{renderBody(body)}</div>
			</div>
			<aside className="submission-studio__preview" aria-label="실시간 미리보기">{preview}</aside>
		</div>
		{after}
	</div>;
}
