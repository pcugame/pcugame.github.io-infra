import type { Dispatch, SetStateAction } from 'react';
import type { AdminProjectDetail, UpdateMemberRequest } from '@pcu/contracts';

import { AddMemberSchema, type AddMemberInput } from '../../../contracts/schemas';
import { MemberRow } from './MemberRow';

type MemberData = AdminProjectDetail['members'][number];

interface AdminProjectMemberEditorProps {
	members: MemberData[];
	newMember: AddMemberInput;
	setNewMember: Dispatch<SetStateAction<AddMemberInput>>;
	canEditContent: boolean;
	isAdding: boolean;
	isBusy: boolean;
	onAdd: (member: AddMemberInput) => void;
	onSwap: (index: number, direction: -1 | 1) => void;
	onUpdate: (memberId: number, body: UpdateMemberRequest) => void;
	onRemove: (memberId: number) => void;
}

export function AdminProjectMemberEditor({
	members,
	newMember,
	setNewMember,
	canEditContent,
	isAdding,
	isBusy,
	onAdd,
	onSwap,
	onUpdate,
	onRemove,
}: AdminProjectMemberEditorProps) {
	return (
		<fieldset>
			<legend>참여 학생</legend>
			<ul className="member-list">
				{members.map((m, idx) => (
					<MemberRow
						key={m.id}
						member={m}
						index={idx}
						total={members.length}
						onSwap={onSwap}
						onUpdate={(body) => onUpdate(m.id, body)}
						onRemove={() => onRemove(m.id)}
						isBusy={isBusy}
						disabled={!canEditContent}
					/>
				))}
			</ul>

			{canEditContent && (
				<div className="member-add-row">
					<input
						type="text"
						placeholder="이름"
						value={newMember.name}
						onChange={(e) =>
							setNewMember((prev) => ({ ...prev, name: e.target.value }))
						}
					/>
					<input
						type="text"
						placeholder="학번"
						value={newMember.studentId}
						onChange={(e) =>
							setNewMember((prev) => ({ ...prev, studentId: e.target.value }))
						}
					/>
					<button
						className="btn btn--secondary btn--small"
						onClick={() => {
							const parsed = AddMemberSchema.safeParse(newMember);
							if (parsed.success) {
								onAdd(parsed.data);
							}
						}}
						disabled={isAdding}
					>
						추가
					</button>
				</div>
			)}
		</fieldset>
	);
}
