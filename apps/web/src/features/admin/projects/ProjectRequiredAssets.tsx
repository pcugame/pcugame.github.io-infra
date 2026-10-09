import type { ProjectRequiredAssets as RequiredAssets, RequiredAssetStatus } from '@pcu/contracts';

const labels = [
	['nativeBuild', '네이티브 빌드'],
	['webBuild', '웹빌드'],
	['video', '동영상'],
	['poster', '포스터'],
] as const;

export function RequiredAssetMark({ label, status }: { label: string; status?: RequiredAssetStatus }) {
	const state = !status ? 'unknown' : status.processing ? 'processing' : status.failed ? 'failed' : status.ready ? 'ready' : 'missing';
	const description = !status ? '확인 불가' : status.processing
		? (status.ready ? '완료 · 처리 중' : '처리 중') : status.failed ? (status.ready ? '오류 · 기존 파일 사용 가능' : '오류') : status.ready ? '완료' : '미완료';
	const text = `${label}: ${description}`;
	return <span className={`required-asset-mark required-asset-mark--${state}`} role="img" aria-label={text} title={text}>
		{state !== 'processing' && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<circle cx="12" cy="12" r="9" />
			{state === 'ready' ? <path d="m8 12 2.5 2.5L16 9" />
				: state === 'failed' ? <path d="m9 9 6 6m0-6-6 6" />
				: state === 'missing' ? <path d="M8.5 12h7" />
					: <><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.75-2.5 2-2.5 3.5" /><path d="M12 16h.01" /></>}
		</svg>}
		{state === 'processing' && <span className="required-asset-mark__spinner" aria-hidden="true" />}
	</span>;
}

export function ProjectRequiredAssets({ summary }: { summary?: RequiredAssets }) {
	return <div className="admin-required-assets" aria-label="필수 에셋 현황">
		{labels.map(([key, label]) => <div className="admin-required-assets__item" key={key}>
			<span className="admin-required-assets__label">{label}</span>
			<RequiredAssetMark label={label} status={summary?.[key]} />
		</div>)}
	</div>;
}
