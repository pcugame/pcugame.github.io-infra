import { useRef, useState } from 'react';
import type { AdminProjectDetail, UpdateMemberRequest } from '@pcu/contracts';
import { AddMemberSchema } from '../../../contracts/schemas';
import { adminMemberApi } from '../../../lib/api';

type Member = AdminProjectDetail['members'][number];
const snapshot = (members: Member[]) => JSON.stringify(members.map(({ id, name, studentId, sortOrder }) => ({ id, name, studentId, sortOrder })));

/** Keep successful operations as the retry baseline; separate member endpoints are not atomic. */
export function useProjectMemberDraft(projectId: number, initialMembers: Member[]) {
	const [members, setMembers] = useState(() => initialMembers.map((member) => ({ ...member })));
	const [baseline, setBaseline] = useState(() => initialMembers.map((member) => ({ ...member })));
	const baselineRef = useRef(baseline);
	const nextLocalId = useRef(-1);
	const validationErrors = members.flatMap((member, index) => {
		const result = AddMemberSchema.safeParse(member);
		return result.success ? [] : result.error.issues.map((issue) => `참여 학생 ${index + 1}: ${issue.path[0] === 'studentId' ? '학번' : '이름'} — ${issue.message}`);
	});
	const checkpoint = (updated: Member[]) => {
		baselineRef.current = [...updated].sort((a, b) => a.sortOrder - b.sortOrder);
		setBaseline(baselineRef.current);
	};
	const update = (id: number, body: UpdateMemberRequest) => setMembers((current) => current.map((member) => member.id === id ? { ...member, ...body } : member));
	const remove = (id: number) => setMembers((current) => current.filter((member) => member.id !== id));
	const add = () => {
		const id = nextLocalId.current--;
		setMembers((current) => [...current, { id, name: '', studentId: '', sortOrder: Math.max(-1, ...current.map((member) => member.sortOrder)) + 1, userId: null }]);
	};
	const swap = (index: number, direction: -1 | 1) => setMembers((current) => {
		const other = index + direction;
		if (!current[index] || !current[other]) return current;
		const result = current.map((member) => ({ ...member }));
		[result[index], result[other]] = [result[other], result[index]];
		const restored = result.length === baselineRef.current.length && result.every((member, position) => member.id === baselineRef.current[position].id);
		return result.map((member, position) => ({ ...member, sortOrder: restored ? baselineRef.current[position].sortOrder : position }));
	});
	const applyChanges = async () => {
		if (validationErrors.length) throw new Error(validationErrors.join('\n'));
		const target = members.map((member) => ({ ...member }));
		for (const stored of [...baselineRef.current]) {
			if (!target.some((member) => member.id === stored.id)) {
				await adminMemberApi.remove(projectId, stored.id);
				checkpoint(baselineRef.current.filter((member) => member.id !== stored.id));
			}
		}
		for (const member of target) {
			if (member.id < 0) {
				const created = await adminMemberApi.add(projectId, { name: member.name, studentId: member.studentId, sortOrder: member.sortOrder });
				const saved = { ...member, id: created.id };
				setMembers((current) => current.map((entry) => entry.id === member.id ? saved : entry));
				checkpoint([...baselineRef.current, saved]);
				continue;
			}
			const stored = baselineRef.current.find((entry) => entry.id === member.id);
			if (!stored) throw new Error('참여 학생 정보를 다시 확인하세요.');
			const body: UpdateMemberRequest = {};
			if (member.name !== stored.name) body.name = member.name;
			if (member.studentId !== stored.studentId) body.studentId = member.studentId;
			if (member.sortOrder !== stored.sortOrder) body.sortOrder = member.sortOrder;
			if (Object.keys(body).length) {
				await adminMemberApi.update(projectId, member.id, body);
				checkpoint(baselineRef.current.map((entry) => entry.id === member.id ? { ...entry, ...body } : entry));
			}
		}
	};
	return { members, hasChanges: snapshot(members) !== snapshot(baseline), validationErrors, update, remove, add, swap, applyChanges };
}
