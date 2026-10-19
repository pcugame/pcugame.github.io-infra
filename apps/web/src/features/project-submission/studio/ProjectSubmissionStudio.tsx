import { publicationReadiness } from '@pcu/contracts';
import { PublicationFeedback } from '../../../components/project/PublicationFeedback';
import { publicationRequirementLabels } from '../../../components/project/publication-labels';
import { Link } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { Controller, useWatch, type FieldErrors } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { useMe } from '../../auth';
import { Button } from '../../../components/ui';
import { ProjectPreviewPanel } from '../../../components/project/ProjectPreviewModal';
import { ExternalLinksFieldset } from '../../../components/project/ExternalLinksFieldset';
import { publicApi, getApiErrorMessage, isApiError } from '../../../lib/api';
import type { ProjectSubmissionMode } from '../../../lib/api/project-submit';
import { getClientUploadLimits, materialUploadLimitsFromConfig } from '../../../lib/upload-limits';
import { SubmitProjectPayloadSchema, type SubmitProjectPayloadInput } from '../../../contracts/schemas';
import { useSubmissionFiles } from '../useSubmissionFiles';
import { useProjectSubmissionForm } from '../useProjectSubmissionForm';
import { SubmissionBackButton } from '../SubmissionBackButton';
import { SubmissionMembersFieldset } from '../SubmissionMembersFieldset';
import { SubmissionPosterSelection } from '../SubmissionFileSelection';
import { SubmissionUploadDialog } from '../SubmissionUploadDialog';
import { StudioFileSelection } from './StudioFileSelection';
import { ProjectRequirementsFieldset } from '../../../components/project/ProjectRequirementsFieldset';
import { StudioIntroduction } from './StudioIntroduction';
import { StudioPreview } from './StudioPreview';
import { ProjectStudio } from '../../../components/project/editor/ProjectStudio';

const lastStep = 3;
const gameInformationFields = ['platforms', 'hardwareRequirements', 'members', 'externalLinks'] as const;
const introductionFields = ['exhibitionId', 'title', 'summary', 'description', 'visibility'] as const;

/** A distinct UI with the same submission, manifest and resumable-upload owners as the original form. */
export function ProjectSubmissionStudio({ mode }: { mode: ProjectSubmissionMode }) {
	const { user } = useMe();
	return <StudioForm key={`${mode}:${user?.id ?? 'anonymous'}:${user?.role ?? ''}:${user?.email ?? ''}`} mode={mode} />;
}

function StudioForm({ mode }: { mode: ProjectSubmissionMode }) {
	const { user } = useMe();
	const limits = getClientUploadLimits(mode === 'admin' ? user?.role ?? 'USER' : 'USER');
	const uploadConfig = useQuery({ queryKey: ['public-upload-config'], queryFn: publicApi.getUploadConfig });
	const materialLimits = materialUploadLimitsFromConfig(uploadConfig.data);
	const files = useSubmissionFiles({ limits, materialLimits });
	const submission = useProjectSubmissionForm({ mode, files });
	const { form, errors, membersFieldArray, selectedYearItem, isSubmitting, isUploadLocked, showGameProgress,
		submissionError, copy } = submission;
	const values = useWatch({ control: form.control }) as SubmitProjectPayloadInput;
	const [step, setStep] = useState(0);
	const [validationNotice, setValidationNotice] = useState('');
	const panel = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const subscription = form.watch((current, { name, type }) => {
			if (type === 'change' && name && form.getFieldState(name).invalid) void form.trigger(name);
			const fields = step === 0 ? introductionFields : step === 1 ? gameInformationFields : [];
			if (fields.length && fields.every(key => SubmitProjectPayloadSchema.shape[key].safeParse(current[key]).success)) setValidationNotice('');
		});
		return () => subscription.unsubscribe();
	}, [form, step]);
	const exhibitionLabel = selectedYearItem ? `${selectedYearItem.year} ${selectedYearItem.title ?? '작품 전시'}` : undefined;
	const changeStep = (next: number, focusError = false) => {
		setStep(next);
		requestAnimationFrame(() => {
			const section = panel.current?.querySelector<HTMLElement>(`[data-studio-step="${next}"]`);
			const target = focusError ? section?.querySelector<HTMLElement>('[aria-invalid="true"]') : null;
			(target ?? section?.querySelector<HTMLElement>('h2'))?.focus({ preventScroll: true });
			const top = panel.current?.getBoundingClientRect().top;
			if (top !== undefined && (top < 0 || top > window.innerHeight - 80)) {
				panel.current?.scrollIntoView({ behavior: 'instant', block: 'start' });
			}
		});
	};
	const revealErrors = (invalid: FieldErrors<SubmitProjectPayloadInput>) => {
		setValidationNotice('표시된 입력 내용을 확인해주세요. 작성한 내용과 선택한 파일은 유지됩니다.');
		changeStep(introductionFields.some(key => invalid[key]) ? 0 : 1, true);
	};
	const nextStep = () => {
		setValidationNotice('');
		changeStep(Math.min(lastStep, step + 1));
	};
	const wantsPublic = values.visibility === 'PUBLIC';
 const readiness = publicationReadiness({ title: values.title ?? '', summary: values.summary, platforms: values.platforms ?? [], members: values.members ?? [], poster: null, assets: [], assetUploads: [
  ...(files.posterFile ? [{ kind: 'POSTER', state: 'UPLOADING' }] : []),
  ...(files.gameFile ? [{ kind: 'GAME', state: 'UPLOADING' }] : []),
  ...(files.videoFiles.length ? [{ kind: 'VIDEO', state: 'UPLOADING' }] : []),
 ] }, user?.role);
 const missing = readiness.requirements.filter(item => item.state === 'MISSING').map(item => publicationRequirementLabels[item.key]);
 const blockedReason = isUploadLocked ? '전시회 업로드가 잠겨 있습니다.' : wantsPublic && step === lastStep && missing.length && !(user?.role === 'ADMIN' && submission.exceptionReason.trim()) ? `공개하려면 다음 항목을 보완하세요: ${missing.join(', ')}` : '';
	const disabled = isSubmitting || showGameProgress;
	const readyToSubmit = SubmitProjectPayloadSchema.safeParse(values).success;
	const error = submissionError ?? submission.submitMutation.error;
 const duplicate = isApiError(error) ? (error.body as { error?: { details?: { projectId?: number; publicationStatus?: string } } })?.error?.details : undefined;
	return <div inert={disabled} aria-hidden={disabled} className="project-studio-host">
		<ProjectStudio title={mode === 'admin' ? '새 작품 등록하기' : '새 작품 만들기'} step={step} onStepChange={changeStep} disabled={disabled} notice={validationNotice}
			secondaryAction={<SubmissionBackButton mode={mode} isDirty={form.formState.isDirty} files={files} disabled={disabled} />}
			panels={[
				<StudioIntroduction submission={submission} />,
				<>
					<Controller control={form.control} name="platforms" render={({ field: platforms }) => <Controller control={form.control} name="hardwareRequirements" render={({ field: hardware }) => <ProjectRequirementsFieldset
						platforms={platforms.value ?? []} hardwareRequirements={hardware.value ?? ''}
						onPlatformsChange={platforms.onChange} onHardwareRequirementsChange={hardware.onChange}
						error={errors.hardwareRequirements?.message}
					/>} />} />
					<SubmissionMembersFieldset append={membersFieldArray.append} swap={membersFieldArray.swap} remove={membersFieldArray.remove} fields={membersFieldArray.fields} register={form.register} errors={errors} />
					<Controller control={form.control} name="externalLinks" render={({ field }) => <ExternalLinksFieldset value={field.value ?? []} onChange={field.onChange} disabled={disabled} showErrors={!!errors.externalLinks} />} />
				</>,
				<>
					<p className="submission-studio__upload-recommendation">공개하려면 포스터·네이티브 게임·동영상이 필요합니다. WebGL·스크린샷·기타 자료는 선택입니다.</p>
					<SubmissionPosterSelection inlineErrors files={files} title={values.title || '새 작품'} limits={limits} enabled={!disabled && !isUploadLocked} />
					<StudioFileSelection files={files} limits={limits} materialLimits={materialLimits} enabled={!disabled && !isUploadLocked} retryConfig={() => void uploadConfig.refetch()} />
				</>,
				<ProjectPreviewPanel active={step === lastStep} values={values} poster={files.posterFile} images={files.imageFiles} videos={files.videoFiles} game={files.gameFile} webgl={files.webglFile} exhibitionLabel={exhibitionLabel} />
			]}
			preview={<StudioPreview values={values} files={files} exhibitionLabel={exhibitionLabel} onPreview={() => changeStep(lastStep)} />}
			feedback={<>{wantsPublic && <PublicationFeedback readiness={readiness} onStep={changeStep} />}{duplicate?.projectId && <p>기존 작품: {duplicate.publicationStatus === 'PUBLIC' ? '공개' : '비공개'} · <Link to={`/admin/projects/${duplicate.projectId}/edit`}>이어서 수정</Link></p>}{blockedReason && <p className="field-error">{blockedReason}</p>}{error != null && <p className="field-error" role="alert">{getApiErrorMessage(error)}</p>}</>}
			actions={<Button type="submit" disabled={disabled || !!blockedReason || (!(wantsPublic && step < lastStep) && !readyToSubmit)}>{isSubmitting ? copy.submittingLabel : wantsPublic ? step < lastStep ? '다음' : '공개 제출' : '저장'}</Button>}
			renderBody={body => <div ref={panel}><form noValidate onSubmit={event => {
				event.preventDefault();
				if (disabled || isUploadLocked) return;
				if (wantsPublic && step < lastStep) { void nextStep(); return; }
				if (blockedReason) { setValidationNotice(blockedReason); return; }
				void form.handleSubmit(submission.onSubmit, revealErrors)(event);
			}}><fieldset className="submission-studio__form-guard" disabled={disabled}><legend className="submission-studio__sr-only">작품 작성</legend>{body}</fieldset></form></div>}
		/>
		<SubmissionUploadDialog submission={submission} files={files} title={values.title || '작품'} />
	</div>;
}
