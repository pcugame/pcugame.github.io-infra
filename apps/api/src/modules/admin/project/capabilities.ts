export function capabilities(project: { status?: string; creatorId: number; members: Array<{ userId: number | null }>; exhibition: { isModificationEnabled?: boolean } }, userId: number, role: string) {
	const isModificationEnabled = project.exhibition.isModificationEnabled !== false;
	const privileged = role === 'ADMIN' || role === 'OPERATOR';
	const related = project.creatorId === userId || project.members.some((member) => member.userId === userId);
	const direct = privileged || (isModificationEnabled && related);
	return {
		isModificationEnabled,
		canEdit: direct,
		canChangeVisibility: direct,
		canDelete: direct,
		canRequestChange: !privileged && !isModificationEnabled && related && project.status !== 'DRAFT',
	};
}

