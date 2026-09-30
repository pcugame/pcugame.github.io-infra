import { zodResolver } from '@hookform/resolvers/zod';
import type { AdminProjectDetail } from '@pcu/contracts';
import { useForm, useWatch } from 'react-hook-form';

import {
	UpdateProjectFormSchema,
	type UpdateProjectFormInput,
} from '../../../contracts/schemas';
import { getApiErrorMessage } from '../../../lib/api';

import { VisibilitySelect, VisibilityNotice } from '../../../components/VisibilitySelect';
import { env } from '../../../lib/env';

interface AdminProjectBasicInfoFormProps {
	project: AdminProjectDetail;
	error: unknown;
	isDirtySubmitting: boolean;
	isSuccess: boolean;
	canEditContent?: boolean;
	onSubmit: (data: UpdateProjectFormInput) => void;
}

export function AdminProjectBasicInfoForm({
	project,
	error,
	isDirtySubmitting,
	isSuccess,
	canEditContent = true,
	onSubmit,
}: AdminProjectBasicInfoFormProps) {
	const {
		register,
		control,
		handleSubmit,
		formState: { errors, isDirty },
	} = useForm<UpdateProjectFormInput>({
		resolver: zodResolver(UpdateProjectFormSchema),
		values: {
			visibility: project.visibility,
			title: project.title,
			summary: project.summary ?? '',
			description: project.description ?? '',
			sortOrder: project.sortOrder,
		},
	});

	const visibility = useWatch({ control, name: 'visibility' });
	return (
		<form onSubmit={handleSubmit(onSubmit)} className="project-form">
		<fieldset disabled={!canEditContent}>
				<legend>기본 정보</legend>
                {env.VISIBILITY_CONTROLS_ENABLED && <div className="form-field">
                 <label htmlFor="edit-visibility">공개 범위</label>
                 <VisibilitySelect id="edit-visibility" disabled={!project.canChangeVisibility} {...register('visibility')} />
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
				</div>

				<div className="form-field">
					<label htmlFor="description">상세 설명</label>
					<textarea id="description" rows={6} {...register('description')} />
				</div>

				<div className="form-field">
					<label htmlFor="sortOrder">오프셋(작을수록 상단에 표시)</label>
					<input
						id="sortOrder"
						type="number"
						{...register('sortOrder', { valueAsNumber: true })}
					/>
				</div>
			</fieldset>

			{error != null && (
				<div className="error-box" role="alert">
					<p>{getApiErrorMessage(error)}</p>
				</div>
			)}
			{isSuccess && (
				<p className="success-message">저장되었습니다.</p>
			)}

			<div className="form-actions">
				<button
					type="submit"
					className="btn btn--primary"
					disabled={!canEditContent || !isDirty || isDirtySubmitting}
				>
					{isDirtySubmitting ? '저장 중…' : '변경사항 저장'}
				</button>
			</div>
		</form>
	);
}
