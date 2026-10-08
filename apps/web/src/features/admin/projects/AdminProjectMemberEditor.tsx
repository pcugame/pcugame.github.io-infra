import { AddMemberSchema } from '../../../contracts/schemas';
import { ProjectMemberRow } from '../../../components/project/editor/ProjectMemberRow';
import { FormSection } from '../../../components/ui';
import type { AdminProjectDetail, UpdateMemberRequest } from '@pcu/contracts';

type MemberData = AdminProjectDetail['members'][number];
interface Props {
	members: MemberData[];
	canEditContent: boolean;
	isBusy: boolean;
	errors: string[];
	onAdd: () => void;
	onSwap: (index: number, direction: -1 | 1) => void;
	onUpdate: (memberId: number, body: UpdateMemberRequest) => void;
	onRemove: (memberId: number) => void;
}
export function AdminProjectMemberEditor({ members, canEditContent, isBusy, errors, onAdd, onSwap, onUpdate, onRemove }: Props) {
	return (
		<FormSection disabled={!canEditContent || isBusy} legend={<>참여 학생 <span className="required-mark">*</span></>}>
			<div className="submission-members__list">
				{members.map((member, index) => {
					const validation = errors.length ? AddMemberSchema.safeParse(member) : undefined;
					const fieldError = (field: 'name' | 'studentId') => {
						const issue = validation && !validation.success ? validation.error.issues.find(issue => issue.path[0] === field) : undefined;
						return issue ? `참여 학생 ${index + 1}: ${field === 'name' ? '이름' : '학번'} — ${issue.message}` : undefined;
					};
					return (
					<ProjectMemberRow key={member.id} index={index} nameError={fieldError('name')} studentIdError={fieldError('studentId')}
						name={{ 'aria-label': `참여 학생 ${index + 1} 이름`, value: member.name, onChange: event => onUpdate(member.id, { name: event.target.value }) }}
						studentId={{ 'aria-label': `참여 학생 ${index + 1} 학번`, value: member.studentId, onChange: event => onUpdate(member.id, { studentId: event.target.value }) }}
						actions={canEditContent && <div className="member-actions">
							<button type="button" className="btn btn--secondary btn--small" aria-label={`참여 학생 ${index + 1} 위로`} disabled={isBusy || index === 0} onClick={() => onSwap(index, -1)}>▲</button>
							<button type="button" className="btn btn--secondary btn--small" aria-label={`참여 학생 ${index + 1} 아래로`} disabled={isBusy || index === members.length - 1} onClick={() => onSwap(index, 1)}>▼</button>
							<button type="button" className="btn btn--danger btn--small" disabled={isBusy} onClick={() => onRemove(member.id)}>삭제</button>
						</div>}
					/>
				); })}
				{canEditContent && <button type="button" className="btn btn--secondary btn--small" disabled={isBusy} onClick={onAdd}>＋ 학생 추가</button>}
			</div>
		</FormSection>
	);
}
