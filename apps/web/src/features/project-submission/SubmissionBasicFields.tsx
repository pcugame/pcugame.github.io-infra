import type { ReactNode } from 'react';
import { FormSection } from '../../components/ui';
import { ProjectRequirementsFieldset } from '../../components/project/ProjectRequirementsFieldset';
import { ExternalLinksFieldset } from '../../components/project/ExternalLinksFieldset';
import { useWatch, Controller } from 'react-hook-form';
import type { Control, FieldErrors, UseFormRegister } from 'react-hook-form';

import type { AdminExhibitionItem } from '../../contracts';
import type { SubmitProjectPayloadInput } from '../../contracts/schemas';
import ExhibitionSelect from '../../components/ExhibitionSelect';

import { VisibilitySelect, VisibilityNotice } from '../../components/VisibilitySelect';
import { env } from '../../lib/env';

interface SubmissionBasicFieldsProps {
	members?: ReactNode;
	control: Control<SubmitProjectPayloadInput>;
	errors: FieldErrors<SubmitProjectPayloadInput>;
	isUploadLocked: boolean;
	isSubmitting: boolean;
	register: UseFormRegister<SubmitProjectPayloadInput>;
	years: AdminExhibitionItem[];
}

export function SubmissionBasicFields({
	control,
	errors,
	isUploadLocked,
	isSubmitting,
	register,
	years,
	members,
}: SubmissionBasicFieldsProps) {
	const exhibitionId = useWatch({ control, name: 'exhibitionId' });
	const visibility = useWatch({ control, name: 'visibility' });
	const exhibition = years.find((item) => item.id === exhibitionId);
	return (
		<>
			<FormSection legend="기본 정보" className="project-basic-fields">
	            {env.VISIBILITY_CONTROLS_ENABLED && <div className="form-field">
	             <label htmlFor="project-visibility">공개 범위</label>
	             <VisibilitySelect id="project-visibility" value={visibility ?? ''} {...register('visibility')} />
	             <VisibilityNotice visibility={visibility} exhibitionVisibility={exhibition?.visibility} />
				<p className="field-hint">작성자·참여자는 공개 범위와 관계없이 조회할 수 있습니다.</p>
	            </div>}

				<div className="form-field">
					<label htmlFor="exhibitionId">전시회 <span className="required-mark">*</span></label>
					{years.length > 0 ? (
						<Controller
							control={control}
							name="exhibitionId"
							render={({ field }) => (
								<ExhibitionSelect
									id="exhibitionId"
									value={field.value && field.value > 0 ? field.value : null}
									onChange={(id) => field.onChange(id)}
									items={years}
									aria-invalid={!!errors.exhibitionId}
								/>
							)}
						/>
					) : (
						<p className="field-error">등록된 전시회가 없습니다. 관리자에게 문의하세요.</p>
					)}
					{errors.exhibitionId && <span className="field-error">{errors.exhibitionId.message}</span>}
					{isUploadLocked && (
						<span className="field-error">
							이 전시회는 업로드가 잠겨 있습니다. 운영자에게 문의하세요.
						</span>
					)}
				</div>

				<div className="form-field">
					<label htmlFor="title">제목 <span className="required-mark">*</span></label>
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
					{errors.description && (
						<span id="description-error" className="field-error">{errors.description.message}</span>
					)}
				</div>
			</FormSection>
			{members}
			<div className="project-environment-links">
				<Controller control={control} name="platforms" render={({ field: platforms }) => (
					<Controller control={control} name="hardwareRequirements" render={({ field: hardware }) => (
						<ProjectRequirementsFieldset platforms={platforms.value ?? []} hardwareRequirements={hardware.value ?? ''} onPlatformsChange={platforms.onChange} onHardwareRequirementsChange={hardware.onChange} disabled={isUploadLocked || isSubmitting} error={errors.hardwareRequirements?.message} />
					)} />
				)} />
				<Controller
					control={control}
					name="externalLinks"
					render={({ field }) => (
						<ExternalLinksFieldset
							value={field.value ?? []}
							onChange={field.onChange}
							disabled={isUploadLocked || isSubmitting}
							showErrors={!!errors.externalLinks}
						/>
					)}
				/>
			</div>
		</>
	);
}
