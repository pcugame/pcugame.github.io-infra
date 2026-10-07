import { FormSection } from '../../components/ui';
import type {
	FieldArrayWithId,
	FieldErrors,
	UseFieldArrayAppend,
	UseFieldArrayRemove,
	UseFormRegister,
} from 'react-hook-form';

import type { SubmitProjectPayloadInput } from '../../contracts/schemas';

interface SubmissionMembersFieldsetProps {
	append: UseFieldArrayAppend<SubmitProjectPayloadInput, 'members'>;
	errors: FieldErrors<SubmitProjectPayloadInput>;
	fields: FieldArrayWithId<SubmitProjectPayloadInput, 'members', 'id'>[];
	register: UseFormRegister<SubmitProjectPayloadInput>;
	remove: UseFieldArrayRemove;
}

export function SubmissionMembersFieldset({
	append,
	errors,
	fields,
	register,
	remove,
}: SubmissionMembersFieldsetProps) {
	return (
		<FormSection legend={<>참여 학생 <span className="required-mark">*</span></>}>
			{errors.members?.root && (
				<span className="field-error">{errors.members.root.message}</span>
			)}
			{errors.members?.message && (
				<span className="field-error">{errors.members.message}</span>
			)}

			{fields.map((field, index) => (
				<div key={field.id} className="member-row">
					<div className="form-field">
						<label htmlFor={`members.${index}.name`}>이름</label>
						<input
							id={`members.${index}.name`}
							aria-required="true"
							aria-invalid={!!errors.members?.[index]?.name}
							aria-describedby={errors.members?.[index]?.name ? `members.${index}.name-error` : undefined}
							type="text"
							{...register(`members.${index}.name`)}
						/>
						{errors.members?.[index]?.name && (
							<span id={`members.${index}.name-error`} className="field-error">
								{errors.members[index].name?.message}
							</span>
						)}
					</div>

					<div className="form-field">
						<label htmlFor={`members.${index}.studentId`}>학번</label>
						<input
							id={`members.${index}.studentId`}
							aria-required="true"
							aria-invalid={!!errors.members?.[index]?.studentId}
							aria-describedby={errors.members?.[index]?.studentId ? `members.${index}.studentId-error` : undefined}
							type="text"
							{...register(`members.${index}.studentId`)}
						/>
						{errors.members?.[index]?.studentId && (
							<span id={`members.${index}.studentId-error`} className="field-error">
								{errors.members[index].studentId?.message}
							</span>
						)}
					</div>

					{fields.length > 1 && (
						<button
							type="button"
							className="btn btn--danger btn--small"
							onClick={() => remove(index)}
						>
							삭제
						</button>
					)}
				</div>
			))}

			<button
				type="button"
				className="btn btn--secondary btn--small"
				onClick={() => append({ name: '', studentId: '' })}
			>
				＋ 학생 추가
			</button>
		</FormSection>
	);
}
