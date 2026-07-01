import { Controller } from 'react-hook-form';
import type { Control, FieldErrors, UseFormRegister } from 'react-hook-form';

import type { AdminExhibitionItem } from '../../contracts';
import type { SubmitProjectPayloadInput } from '../../contracts/schemas';
import ExhibitionSelect from '../../components/ExhibitionSelect';

interface SubmissionBasicFieldsProps {
	control: Control<SubmitProjectPayloadInput>;
	errors: FieldErrors<SubmitProjectPayloadInput>;
	isUploadLocked: boolean;
	register: UseFormRegister<SubmitProjectPayloadInput>;
	years: AdminExhibitionItem[];
}

export function SubmissionBasicFields({
	control,
	errors,
	isUploadLocked,
	register,
	years,
}: SubmissionBasicFieldsProps) {
	return (
		<fieldset>
			<legend>기본 정보</legend>

			<div className="form-field">
				<label htmlFor="exhibitionId">전시회 *</label>
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
				{errors.description && (
					<span className="field-error">{errors.description.message}</span>
				)}
			</div>
		</fieldset>
	);
}
