import { SelectControl } from '../../../components/ui/SelectControl';
import { ProjectIntroductionFields } from '../../../components/project/editor/ProjectIntroductionFields';
import type { ReactNode } from 'react';
import { FormSection } from '../../../components/ui';
import { ProjectRequirementsFieldset } from '../../../components/project/ProjectRequirementsFieldset';
import { ExternalLinksFieldset } from '../../../components/project/ExternalLinksFieldset';
import { Controller, useWatch } from 'react-hook-form';
import type { AdminProjectDetail } from '@pcu/contracts';
import type { FormEventHandler } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import type { UpdateProjectFormInput } from '../../../contracts/schemas';

interface Props {
	section?: 'introduction' | 'game';
	members?: ReactNode;
	project: AdminProjectDetail;
	form: UseFormReturn<UpdateProjectFormInput>;
	formId: string;
	isPending: boolean;
	canEditContent: boolean;
	onSubmit: FormEventHandler<HTMLFormElement>;
}
export function AdminProjectBasicInfoForm({ project, form, formId, isPending, canEditContent, onSubmit, members, section }: Props) {
	const { register, formState: { errors } } = form;
	const summary = useWatch({ control: form.control, name: 'summary' }) ?? '';
	const visibility = useWatch({ control: form.control, name: 'visibility' });
	const platforms = useWatch({ control: form.control, name: 'platforms' });
	const hardwareRequirements = useWatch({ control: form.control, name: 'hardwareRequirements' });

	const content = (
		<>
			{section !== 'game' && <>
			<FormSection disabled={!canEditContent || isPending} legend="기본 정보" className="project-basic-fields">
				<div className="form-field"><label htmlFor="edit-exhibition">전시회 <span className="required-mark">*</span></label><input id="edit-exhibition" readOnly value={`${project.year} 작품 전시`} /></div>
				<ProjectIntroductionFields title={register('title')} summary={register('summary')} description={register('description')} summaryLength={summary.length} errors={{ title: errors.title?.message, summary: errors.summary?.message, description: errors.description?.message }} />
    <div className="form-field"><label htmlFor="edit-visibility">공개 여부</label>
     <SelectControl id="edit-visibility" disabled={!project.canChangeVisibility} value={visibility ?? 'STAFF'} {...register('visibility')}><option value="STAFF">비공개</option><option value="PUBLIC">공개</option></SelectControl>
     <p className="field-hint">비공개 작품은 작성자·연결된 참여자·운영자·관리자만 조회할 수 있습니다.</p>
    </div>
			</FormSection>
			<FormSection legend="관리 정보" disabled={!canEditContent || isPending}>

				<div className="form-field">
					<label htmlFor="sortOrder">오프셋(작을수록 상단에 표시)</label>
					<input id="sortOrder" aria-invalid={!!errors.sortOrder} aria-describedby={errors.sortOrder ? "sortOrder-error" : undefined} type="number" {...register('sortOrder', { valueAsNumber: true })} />
					{errors.sortOrder && <span id="sortOrder-error" className="field-error">{errors.sortOrder.message}</span>}
				</div>
			</FormSection>
			</>}
			{section !== 'introduction' && <>
			<div className="project-environment-links">
				<ProjectRequirementsFieldset platforms={platforms ?? []} hardwareRequirements={hardwareRequirements ?? ''} onPlatformsChange={(value) => form.setValue('platforms', value, { shouldDirty: true, shouldValidate: true })} onHardwareRequirementsChange={(value) => form.setValue('hardwareRequirements', value, { shouldDirty: true, shouldValidate: true })} disabled={!canEditContent || isPending} error={errors.hardwareRequirements?.message} />
				{members}
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
			</>}
		</>
	);
	return section ? content : <form id={formId} onSubmit={onSubmit} className="project-form">{content}</form>;
}
