import { useCallback, useRef, useState } from 'react';
import { Controller, useWatch, type FieldErrors } from 'react-hook-form';
import { Link, useBeforeUnload } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useMe } from '../../auth';
import { Button } from '../../../components/ui';
import { ProjectPreviewModal } from '../../../components/project/ProjectPreviewModal';
import { ExternalLinksFieldset } from '../../../components/project/ExternalLinksFieldset';
import { publicApi, getApiErrorMessage } from '../../../lib/api';
import type { ProjectSubmissionMode } from '../../../lib/api/project-submit';
import { getClientUploadLimits, materialUploadLimitsFromConfig } from '../../../lib/upload-limits';
import { visibilityLabels } from '../../../lib/visibility';
import { env } from '../../../lib/env';
import type { SubmitProjectPayloadInput } from '../../../contracts/schemas';
import { useSubmissionFiles } from '../useSubmissionFiles';
import { useProjectSubmissionForm } from '../useProjectSubmissionForm';
import { SubmissionMembersFieldset } from '../SubmissionMembersFieldset';
import { SubmissionPosterSelection } from '../SubmissionFileSelection';
import { SubmissionUploadProgress } from '../SubmissionUploadProgress';
import { StudioFileSelection } from './StudioFileSelection';
import { studioFileGroups } from './fileGroups';
import { StudioIntroduction } from './StudioIntroduction';
import { StudioPreview, StudioReview } from './StudioPreview';

const steps = [
	{ title: '작품 소개', description: '전시 페이지에 표시할 기본 정보를 작성하세요.' },
	{ title: '팀과 자료', description: '함께 만든 사람들과 게임의 모습을 소개하세요.' },
	{ title: '제출 전 확인', description: '관람객에게 보여줄 내용을 한 번 더 확인하세요.' },
];
const introductionFields = ['exhibitionId', 'title', 'summary', 'description', 'visibility', 'platforms', 'hardwareRequirements'] as const;

/** A distinct UI with the same submission, manifest and resumable-upload owners as the original form. */
export function ProjectSubmissionStudio({ mode }: { mode: ProjectSubmissionMode }) {
	const { user } = useMe();
	return <StudioForm key={`${mode}:${user?.id}:${user?.role}`} mode={mode} />;
}

function StudioForm({ mode }: { mode: ProjectSubmissionMode }) {
	const { user } = useMe();
	const limits = getClientUploadLimits(mode === 'admin' ? user?.role ?? 'USER' : 'USER');
	const uploadConfig = useQuery({ queryKey: ['public-upload-config'], queryFn: publicApi.getUploadConfig });
	const materialLimits = materialUploadLimitsFromConfig(uploadConfig.data);
	const files = useSubmissionFiles({ limits, materialLimits });
	const submission = useProjectSubmissionForm({ mode, files });
	const { form, errors, membersFieldArray, selectedYearItem, isSubmitting, isUploadLocked, showGameProgress,
		createdProjectId, submissionItems, finalizeIfReady, submissionError, copy, exhibitionsQuery } = submission;
	const values = useWatch({ control: form.control }) as SubmitProjectPayloadInput;
	const [step, setStep] = useState(0);
	const [preview, setPreview] = useState<SubmitProjectPayloadInput | null>(null);
	const [validationNotice, setValidationNotice] = useState('');
	const [checking, setChecking] = useState(false);
	const panel = useRef<HTMLDivElement>(null);
	const exhibitionLabel = selectedYearItem ? `${selectedYearItem.year} ${selectedYearItem.title ?? '작품 전시'}` : undefined;
	const basePath = mode === 'admin' ? '/admin/projects' : '/me/projects';
	const fileCount = Number(!!files.posterFile) + Number(!!files.gameFile) + Number(!!files.webglFile)
		+ files.imageFiles.length + files.videoFiles.length + files.documentFiles.length + files.attachmentFiles.length;
	const hasUnsavedInput = form.formState.isDirty || fileCount > 0;
	useBeforeUnload(useCallback((event: BeforeUnloadEvent) => {
		if (hasUnsavedInput || showGameProgress || isSubmitting) { event.preventDefault(); event.returnValue = ''; }
	}, [hasUnsavedInput, showGameProgress, isSubmitting]));
	const uploadFinished = useCallback(() => {
		if (createdProjectId !== null) void finalizeIfReady(createdProjectId);
	}, [createdProjectId, finalizeIfReady]);
	const changeStep = (next: number, focusError = false) => {
		setStep(next);
		requestAnimationFrame(() => {
			const section = panel.current?.querySelector<HTMLElement>(`[data-studio-step="${next}"]`);
			const target = focusError ? section?.querySelector<HTMLElement>('[aria-invalid="true"]') : null;
			(target ?? section?.querySelector<HTMLElement>('h2'))?.focus({ preventScroll: true });
			panel.current?.scrollIntoView({ behavior: 'instant', block: 'start' });
		});
	};
	const revealErrors = (invalid: FieldErrors<SubmitProjectPayloadInput>) => {
		setValidationNotice('표시된 입력 내용을 확인해주세요. 작성한 내용과 선택한 파일은 유지됩니다.');
		changeStep(introductionFields.some(key => invalid[key]) ? 0 : 1, true);
	};
	const nextStep = async () => {
		setChecking(true);
		try {
			const keys = step === 0 ? [...introductionFields] : undefined;
			if (!await form.trigger(keys)) {
				const invalid = Object.fromEntries([...introductionFields, 'members', 'externalLinks'].map(key => [key, form.getFieldState(key as keyof SubmitProjectPayloadInput).error]));
				revealErrors(invalid);
				return;
			}
			setValidationNotice('');
			changeStep(Math.min(2, step + 1));
		} finally { setChecking(false); }
	};
	const blockedReason = isUploadLocked ? '전시회 업로드가 잠겨 있습니다.'
		: !selectedYearItem || !exhibitionsQuery.isSuccess ? '작품 소개에서 제출할 전시회를 선택해주세요.' : '';
	const disabled = isSubmitting || checking;
	const error = submissionError ?? submission.submitMutation.error;
	return <div className="submission-studio">
		<header className="admin-page-header submission-studio__header">
			<div className="admin-page-header__text"><h1>{mode === 'admin' ? '새 작품 등록하기' : '새 작품 만들기'}</h1></div>
			{!showGameProgress && <Button variant="secondary" onClick={() => setPreview(form.getValues())} disabled={isSubmitting}>미리보기 ↗</Button>}
		</header>
		<div className="submission-studio__layout">
			<nav className="submission-studio__rail" aria-label="작품 작성 단계">
				{steps.map((item, index) => <button key={item.title} type="button" className={`submission-studio__step${step === index && !showGameProgress ? ' is-active' : ''}`} aria-current={step === index && !showGameProgress ? 'step' : undefined} disabled={disabled || showGameProgress} onClick={() => changeStep(index)}><span>{index + 1}</span>{item.title}</button>)}
				<div className="submission-studio__guide"><a href={`${import.meta.env.BASE_URL}unity-webgl-guide/`} target="_blank" rel="noopener noreferrer">Unity WebGL 업로드 가이드 ↗</a></div>
			</nav>
			<div className="submission-studio__sheet" ref={panel}>
				{showGameProgress ? <section className="submission-studio__progress" aria-label="제출 진행 상태">
					<div className="submission-studio__sheet-heading"><h2>작품을 준비하고 있어요.</h2><p>파일 업로드와 검증이 끝나면 작품이 공개됩니다.</p></div>
					<div className="submission-studio__fields"><p className="submission-studio__notice">이 화면에서 진행 상태를 확인하세요. 중간에 끊긴 파일은 동일한 원본 파일을 선택해 이어올릴 수 있습니다.</p>
						{error != null && <div className="error-box" role="alert">{getApiErrorMessage(error)}</div>}
						{submission.canRetryStatus && <Button disabled={submission.isFinalizing} onClick={() => void submission.retryStatus()}>제출 상태 다시 확인</Button>}
						{import.meta.env.VITE_MOCK === 'true' && submission.canRetryPublication && <Button disabled={submission.isFinalizing} onClick={() => void submission.retryPublication()}>Mock 발행 다시 시도</Button>}
						<SubmissionUploadProgress zone="poster" title={values.title || '작품'} projectId={createdProjectId!} files={files} items={submissionItems} onComplete={uploadFinished} />
						{studioFileGroups.map(group => <SubmissionUploadProgress key={group.id} zone="files" group={group} projectId={createdProjectId!} files={files} items={submissionItems} onComplete={uploadFinished} />)}
						<Button variant="danger" size="small" onClick={() => void submission.cancelSubmission()}>제출 취소</Button>
					</div>
				</section> : <form noValidate onSubmit={event => {
					event.preventDefault();
					if (disabled || isUploadLocked) return;
					if (step < 2) { void nextStep(); return; }
					if (blockedReason) { setValidationNotice(blockedReason); return; }
					void form.handleSubmit(submission.onSubmit, revealErrors)(event);
				}}>
					<fieldset className="submission-studio__form-guard" disabled={disabled}>
						<legend className="submission-studio__sr-only">작품 작성</legend>
						{steps.map((item, index) => <section key={item.title} data-studio-step={index} hidden={step !== index} aria-labelledby={`studio-step-title-${index}`}>
							<div className="submission-studio__sheet-heading"><div><h2 id={`studio-step-title-${index}`} tabIndex={-1}>{item.title}</h2><p>{item.description}</p></div><span>0{index + 1} / 03</span></div>
							<div className="submission-studio__fields">
								{index === 0 && <StudioIntroduction submission={submission} />}
								{index === 1 && <>
									<SubmissionMembersFieldset append={membersFieldArray.append} remove={membersFieldArray.remove} fields={membersFieldArray.fields} register={form.register} errors={errors} />
									<SubmissionPosterSelection files={files} title={values.title || '새 작품'} limits={limits} enabled={!disabled && !isUploadLocked} />
									<StudioFileSelection files={files} limits={limits} materialLimits={materialLimits} enabled={!disabled && !isUploadLocked} retryConfig={() => void uploadConfig.refetch()} />
									{files.fileSizeError && <p className="field-error" role="alert">{files.fileSizeError}</p>}
									<Controller control={form.control} name="externalLinks" render={({ field }) => <ExternalLinksFieldset value={field.value ?? []} onChange={field.onChange} disabled={disabled} showErrors={!!errors.externalLinks} />} />
								</>}
								{index === 2 && <StudioReview values={values} files={files} exhibitionLabel={exhibitionLabel} visibilityLabel={env.VISIBILITY_CONTROLS_ENABLED ? visibilityLabels[values.visibility ?? 'PUBLIC'] : undefined} onEdit={changeStep} />}
							</div>
						</section>)}
						<div className="submission-studio__feedback" aria-live="polite">
							{validationNotice && <p className="field-error">{validationNotice}</p>}
							{step === 2 && blockedReason && <p className="field-error">{blockedReason}</p>}
							{error != null && <p className="field-error" role="alert">{getApiErrorMessage(error)}</p>}
						</div>
						<footer className="submission-studio__actions">
							{step === 0 ? <span>다음으로 팀과 자료를 추가해요.</span> : <Button variant="secondary" onClick={() => changeStep(step - 1)}>← 이전 단계</Button>}
							{step < 2 ? <Button key="next" onClick={() => void nextStep()}>다음 단계 →</Button> : <Button key="submit" type="submit" disabled={!!blockedReason}>{isSubmitting ? copy.submittingLabel : copy.submitLabel}</Button>}
						</footer>
					</fieldset>
				</form>}
			</div>
			<aside className="submission-studio__preview" aria-label={showGameProgress ? '업로드 현황' : '실시간 미리보기'}>
				{showGameProgress ? <div className="submission-studio__upload-summary"><h2>업로드 현황</h2><strong>{submissionItems.filter(item => item.state === 'READY').length}<span> / {submissionItems.length}</span></strong><p>파일 검증 완료</p><p className="field-hint">{submission.isFinalizing ? '작품의 제출 상태를 확인하고 있습니다.' : '파일별 진행 상태는 왼쪽에서 확인할 수 있습니다.'}</p></div> : <StudioPreview values={values} files={files} exhibitionLabel={exhibitionLabel} onPreview={() => setPreview(form.getValues())} />}
			</aside>
		</div>
		<footer className="submission-studio__footer"><Link to={basePath} onClick={event => { if ((hasUnsavedInput || showGameProgress) && !window.confirm('이 화면을 나가시겠어요? 제출 전 입력 내용과 파일 선택은 저장되지 않습니다. 진행 중인 업로드는 원본 파일을 다시 선택해 이어올릴 수 있습니다.')) event.preventDefault(); }}>{mode === 'admin' ? '작품 관리로 돌아가기' : '내 작품으로 돌아가기'}</Link>{!showGameProgress && !isSubmitting && <Link to={`${basePath}/new`} onClick={event => { if (hasUnsavedInput && !window.confirm('기존 화면으로 이동하면 작성한 내용과 파일 선택이 초기화됩니다. 이동하시겠어요?')) event.preventDefault(); }}>기존 업로드 화면으로 이동 ↗</Link>}</footer>
		{preview && <ProjectPreviewModal values={preview} poster={files.posterFile} images={files.imageFiles} videos={files.videoFiles} game={files.gameFile} exhibitionLabel={exhibitionLabel} onClose={() => setPreview(null)} />}
	</div>;
}
