import { ProjectRequirementsFieldset } from '../../../components/project/ProjectRequirementsFieldset';
import { ExternalLinksFieldset } from '../../../components/project/ExternalLinksFieldset';
import { Controller, useWatch } from 'react-hook-form';
import type { AdminProjectDetail } from '@pcu/contracts';
import { VisibilitySelect, VisibilityNotice } from '../../../components/VisibilitySelect';
import { env } from '../../../lib/env';
import type { FormEventHandler } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import type { UpdateProjectFormInput } from '../../../contracts/schemas';

interface Props {
	project: AdminProjectDetail;
	form: UseFormReturn<UpdateProjectFormInput>;
	formId: string;
	isPending: boolean;
	canEditContent: boolean;
	onSubmit: FormEventHandler<HTMLFormElement>;
}
export function AdminProjectBasicInfoForm({ project, form, formId, isPending, canEditContent, onSubmit }: Props) {
	const { register, formState: { errors } } = form;
	const visibility = useWatch({ control: form.control, name: 'visibility' });
	const platforms = useWatch({ control: form.control, name: 'platforms' });
	const hardwareRequirements = useWatch({ control: form.control, name: 'hardwareRequirements' });

	return (
		<form id={formId} onSubmit={onSubmit} className="project-form">
			<fieldset disabled={!canEditContent || isPending}>
				<legend>기본 정보</legend>
                {env.VISIBILITY_CONTROLS_ENABLED && <div className="form-field">
                 <label htmlFor="edit-visibility">공개 범위</label>
                 <VisibilitySelect id="edit-visibility" disabled={!project.canChangeVisibility} value={visibility ?? ''} {...register('visibility')} />
                 {!project.canChangeVisibility && <p className="field-hint">현재 공개 범위를 변경할 권한이 없습니다. 수정이 잠긴 전시회에서는 운영자·관리자만 변경할 수 있습니다.</p>}
                 <VisibilityNotice visibility={visibility} exhibitionVisibility={project.exhibitionVisibility} />
                </div>}


				<div className="form-field">
					<label htmlFor="title">제목 *</label>
					<input id="title" type="text" {...register('title')} />
					{errors.title && <span className="field-error">{errors.title.message}</span>}
				</div>
				<div className="form-field">
					<label htmlFor="summary">한줄 소개</label>
					<input id="summary" type="text" {...register('summary')} />
					{errors.summary && <span className="field-error">{errors.summary.message}</span>}
				</div>
				<div className="form-field">
					<label htmlFor="description">상세 설명</label>
					<textarea id="description" rows={6} {...register('description')} />
					{errors.description && <span className="field-error">{errors.description.message}</span>}
				</div>
				<div className="form-field">
					<label htmlFor="sortOrder">오프셋(작을수록 상단에 표시)</label>
					<input id="sortOrder" type="number" {...register('sortOrder', { valueAsNumber: true })} />
					{errors.sortOrder && <span className="field-error">{errors.sortOrder.message}</span>}
				</div>
			</fieldset>
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
		</form>
	);
}
