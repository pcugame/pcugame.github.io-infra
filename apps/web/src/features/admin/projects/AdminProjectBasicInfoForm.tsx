import { zodResolver } from '@hookform/resolvers/zod';
import type { AdminProjectDetail } from '@pcu/contracts';
import { useForm } from 'react-hook-form';

import {
	UpdateProjectFormSchema,
	type UpdateProjectFormInput,
} from '../../../contracts/schemas';
import { getApiErrorMessage } from '../../../lib/api';

interface AdminProjectBasicInfoFormProps {
	project: AdminProjectDetail;
	error: unknown;
	isDirtySubmitting: boolean;
	isSuccess: boolean;
	onSubmit: (data: UpdateProjectFormInput) => void;
}

export function AdminProjectBasicInfoForm({
	project,
	error,
	isDirtySubmitting,
	isSuccess,
	onSubmit,
}: AdminProjectBasicInfoFormProps) {
	const {
		register,
		handleSubmit,
		formState: { errors, isDirty },
	} = useForm<UpdateProjectFormInput>({
		resolver: zodResolver(UpdateProjectFormSchema),
		values: {
			title: project.title,
			summary: project.summary ?? '',
			description: project.description ?? '',
			sortOrder: project.sortOrder,
		},
	});

	return (
		<form onSubmit={handleSubmit(onSubmit)} className="project-form">
			<fieldset>
				<legend>기본 정보</legend>

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
					<label htmlFor="sortOrder">정렬 순서</label>
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
					disabled={!isDirty || isDirtySubmitting}
				>
					{isDirtySubmitting ? '저장 중…' : '변경사항 저장'}
				</button>
			</div>
		</form>
	);
}
