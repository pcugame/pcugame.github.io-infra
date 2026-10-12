export interface ProjectAccessRecord {
	id: number;
	exhibitionId: number;
	creatorId: number;
	status: string;
	isChangeRequestDraft?: boolean;
	changeRequestActorId?: number;
	changeRequestState?: string;
	changeRequestSourceCreatorId?: number;
	changeRequestSourceMemberIds?: Array<number | null>;
	/**
	 * This is deliberately a project write policy, rather than a read policy.
	 * Archived projects remain visible to their creator and linked members.
	 */
	isModificationEnabled?: boolean;
}

export interface ProjectAccessRepository {
	findProject(projectId: number): Promise<ProjectAccessRecord | null>;
	isLinkedMember(projectId: number, userId: number): Promise<boolean>;
}
