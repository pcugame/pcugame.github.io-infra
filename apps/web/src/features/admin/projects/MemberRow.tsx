import { useState } from 'react';
import type { AdminProjectDetail, UpdateMemberRequest } from '@pcu/contracts';

type MemberData = AdminProjectDetail['members'][number];

export function MemberRow({
	member,
	index,
	total,
	onSwap,
	onUpdate,
	onRemove,
	isBusy,
	disabled = false,
}: {
	member: MemberData;
	index: number;
	total: number;
	onSwap: (index: number, direction: -1 | 1) => void;
	onUpdate: (body: UpdateMemberRequest) => void;
	onRemove: () => void;
	isBusy: boolean;
	disabled?: boolean;
}) {
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(member.name);
	const [studentId, setStudentId] = useState(member.studentId);

	const handleSave = () => {
		const body: UpdateMemberRequest = {};
		if (name !== member.name) body.name = name;
		if (studentId !== member.studentId) body.studentId = studentId;
		if (Object.keys(body).length > 0) onUpdate(body);
		setEditing(false);
	};

	const handleCancel = () => {
		setName(member.name);
		setStudentId(member.studentId);
		setEditing(false);
	};

	if (editing) {
		return (
			<li className="member-list__item">
				<input
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="member-edit-input"
				/>
				<input
					type="text"
					value={studentId}
					onChange={(e) => setStudentId(e.target.value)}
					className="member-edit-input"
				/>
				<button
					className="btn btn--primary btn--small"
					onClick={handleSave}
					disabled={isBusy || (!name || !studentId)}
				>
					저장
				</button>
				<button className="btn btn--secondary btn--small" onClick={handleCancel}>
					취소
				</button>
			</li>
		);
	}

	return (
		<li className="member-list__item">
			<span>
				{member.name} ({member.studentId})
				<span className="member-sort-order">
					#{member.sortOrder}
				</span>
			</span>
			{!disabled && (
				<div className="member-actions">
					<button
						className="btn btn--secondary btn--small"
						onClick={() => onSwap(index, -1)}
						disabled={isBusy || index === 0}
						title="위로"
					>
						▲
					</button>
					<button
						className="btn btn--secondary btn--small"
						onClick={() => onSwap(index, 1)}
						disabled={isBusy || index === total - 1}
						title="아래로"
					>
						▼
					</button>
					<button
						className="btn btn--secondary btn--small"
						onClick={() => setEditing(true)}
					>
						수정
					</button>
					<button
						className="btn btn--danger btn--small"
						onClick={onRemove}
						disabled={isBusy}
					>
						삭제
					</button>
				</div>
			)}
		</li>
	);
}
