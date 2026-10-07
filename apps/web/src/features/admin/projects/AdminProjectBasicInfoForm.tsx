import type { ReactNode } from 'react';
import { FormSection } from '../../../components/ui';
import { ProjectRequirementsFieldset } from '../../../components/project/ProjectRequirementsFieldset';
import { ExternalLinksFieldset } from '../../../components/project/ExternalLinksFieldset';
import { Controller, useWatch } from 'react-hook-form';
import type { AdminProjectDetail } from '@pcu/contracts';
import { VisibilitySelect, VisibilityNotice } from '../../../components/VisibilitySelect';
import { visibilityLabels, visibilityRank } from '../../../lib/visibility';
import { env } from '../../../lib/env';
import type { FormEventHandler } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import type { UpdateProjectFormInput } from '../../../contracts/schemas';

interface Props {
	members?: ReactNode;
	project: AdminProjectDetail;
	form: UseFormReturn<UpdateProjectFormInput>;
	formId: string;
	isPending: boolean;
	canEditContent: boolean;
	onSubmit: FormEventHandler<HTMLFormElement>;
}
export function AdminProjectBasicInfoForm({ project, form, formId, isPending, canEditContent, onSubmit, members }: Props) {
	const { register, formState: { errors } } = form;
	const visibility = useWatch({ control: form.control, name: 'visibility' });
	const effectiveVisibility = visibilityRank[project.visibility] >= visibilityRank[project.exhibitionVisibility] ? project.visibility : project.exhibitionVisibility;
	const platforms = useWatch({ control: form.control, name: 'platforms' });
	const hardwareRequirements = useWatch({ control: form.control, name: 'hardwareRequirements' });

	return (
		<form id={formId} onSubmit={onSubmit} className="project-form">
			<div className="form-field" aria-label="저장된 공개 범위">
				<p>저장된 공개 범위: {visibilityLabels[project.visibility]} · 전시회: {visibilityLabels[project.exhibitionVisibility]}</p>
				<p>{project.status === 'DRAFT' ? '제출 중인 작품은 공개 조회되지 않습니다.' : `현재 조회 대상: ${visibilityLabels[effectiveVisibility]}. 작성자·참여자는 공개 범위와 관계없이 조회할 수 있습니다.`}</p>
				{!env.VISIBILITY_CONTROLS_ENABLED && <p className="field-hint">현재 공개 범위 변경 기능이 비활성화되어 있습니다. 보관으로 변경해도 접근은 제한되지 않습니다.</p>}
			</div>
			<FormSection disabled={!canEditContent || isPending} legend="기본 정보" className="project-basic-fields">
                {env.VISIBILITY_CONTROLS_ENABLED && <div className="form-field">
                 <label htmlFor="edit-visibility">공개 범위</label>
                 <VisibilitySelect id="edit-visibility" disabled={!project.canChangeVisibility} value={visibility ?? ''} {...register('visibility')} />
                 {!project.canChangeVisibility && <p className="field-hint">현재 공개 범위를 변경할 권한이 없습니다. 수정이 잠긴 전시회에서는 운영자·관리자만 변경할 수 있습니다.</p>}
                 <VisibilityNotice visibility={visibility} exhibitionVisibility={project.exhibitionVisibility} />
                 <p className="field-hint">작성자·참여자는 공개 범위와 관계없이 조회할 수 있습니다.</p>
                 {visibility !== project.visibility && <p className="field-hint">선택한 공개 범위는 아직 저장되지 않았습니다. 적용 후 반영됩니다.</p>}
                </div>}


				<div className="form-field">
					<label htmlFor="sortOrder">오프셋(작을수록 상단에 표시)</label>
					<input id="sortOrder" aria-invalid={!!errors.sortOrder} aria-describedby={errors.sortOrder ? "sortOrder-error" : undefined} type="number" {...register('sortOrder', { valueAsNumber: true })} />
					{errors.sortOrder && <span id="sortOrder-error" className="field-error">{errors.sortOrder.message}</span>}
				</div>
				<div className="form-field">
					<label htmlFor="title">제목 *</label>
					<input id="title" aria-required="true" aria-invalid={!!errors.title} aria-describedby={errors.title ? "title-error" : undefined} type="text" {...register('title')} />
					{errors.title && <span id="title-error" className="field-error">{errors.title.message}</span>}
				</div>
				<div className="form-field">
					<label htmlFor="summary">한줄 소개</label>
					<input id="summary" aria-invalid={!!errors.summary} aria-describedby={errors.summary ? "summary-error" : undefined} type="text" {...register('summary')} />
					{errors.summary && <span id="summary-error" className="field-error">{errors.summary.message}</span>}
				</div>
				<div className="form-field">
					<label htmlFor="description">상세 설명</label>
					<textarea id="description" aria-invalid={!!errors.description} aria-describedby={errors.description ? "description-error" : undefined} rows={3} {...register('description')} />
					{errors.description && <span id="description-error" className="field-error">{errors.description.message}</span>}
				</div>

			</FormSection>
			{members}
			<div className="project-environment-links">
				<ProjectRequirementsFieldset platforms={platforms ?? []} hardwareRequirements={hardwareRequirements ?? ''} onPlatformsChange={(value) => form.setValue('platforms', value, { shouldDirty: true, shouldValidate: true })} onHardwareRequirementsChange={(value) => form.setValue('hardwareRequirements', value, { shouldDirty: true, shouldValidate: true })} disabled={!canEditContent || isPending} error={errors.hardwareRequirements?.message} />
				<Controller
					control={form.control}
					name="externalLinks"
					render={({ field }) => (
						<ExternalLinksFieldset
							value={field.value ?? []}
							onChange={field.onChange}
							disabled={!canEditContent || isPending}
							showErrors={!!errors.externalLinks}
						/>
					)}
				/>
			</div>
		</form>
	);
}
