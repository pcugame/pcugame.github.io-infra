import type { FormEventHandler } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import type { UpdateProjectFormInput } from '../../../contracts/schemas';

interface Props {
	form: UseFormReturn<UpdateProjectFormInput>;
	formId: string;
	isPending: boolean;
	canEditContent: boolean;
	onSubmit: FormEventHandler<HTMLFormElement>;
}
export function AdminProjectBasicInfoForm({ form, formId, isPending, canEditContent, onSubmit }: Props) {
	const { register, formState: { errors } } = form;
	return (
		<form id={formId} onSubmit={onSubmit} className="project-form">
			<fieldset disabled={!canEditContent || isPending}>
				<legend>기본 정보</legend>
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
		</form>
	);
}
