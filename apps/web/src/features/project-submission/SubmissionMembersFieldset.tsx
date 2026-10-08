import { ProjectMemberRow } from '../../components/project/editor/ProjectMemberRow';
import { FormSection } from '../../components/ui';
import type {
	FieldArrayWithId,
	FieldErrors,
	UseFieldArrayAppend,
	UseFieldArrayRemove,
	UseFieldArraySwap,
	UseFormRegister,
} from 'react-hook-form';

import type { SubmitProjectPayloadInput } from '../../contracts/schemas';

interface SubmissionMembersFieldsetProps {
	append: UseFieldArrayAppend<SubmitProjectPayloadInput, 'members'>;
	errors: FieldErrors<SubmitProjectPayloadInput>;
	fields: FieldArrayWithId<SubmitProjectPayloadInput, 'members', 'id'>[];
	register: UseFormRegister<SubmitProjectPayloadInput>;
	remove: UseFieldArrayRemove;
	swap: UseFieldArraySwap;
}

export function SubmissionMembersFieldset({
	append,
	errors,
	fields,
	register,
	remove,
	swap,
}: SubmissionMembersFieldsetProps) {
	return (
		<FormSection legend={<>참여 학생 <span className="required-mark">*</span></>}>
			{errors.members?.root && (
				<span className="field-error">{errors.members.root.message}</span>
			)}
			{errors.members?.message && (
				<span className="field-error">{errors.members.message}</span>
			)}

			<div className="submission-members__list">
			{fields.map((field, index) => <ProjectMemberRow key={field.id} index={index}
				name={register(`members.${index}.name`)} studentId={register(`members.${index}.studentId`)}
				nameError={errors.members?.[index]?.name?.message} studentIdError={errors.members?.[index]?.studentId?.message}
				actions={<div className="member-actions">
					<button type="button" className="btn btn--secondary btn--small" aria-label={`참여 학생 ${index + 1} 위로`} disabled={index === 0} onClick={() => swap(index, index - 1)}>▲</button>
					<button type="button" className="btn btn--secondary btn--small" aria-label={`참여 학생 ${index + 1} 아래로`} disabled={index === fields.length - 1} onClick={() => swap(index, index + 1)}>▼</button>
					{fields.length > 1 && <button type="button" className="btn btn--danger btn--small" onClick={() => remove(index)}>삭제</button>}
				</div>}
			/>)}

			<button
				type="button"
				className="btn btn--secondary btn--small"
				onClick={() => append({ name: '', studentId: '' })}
			>
				＋ 학생 추가
			</button>
			</div>
		</FormSection>
	);
}
