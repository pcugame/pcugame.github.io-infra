import type { ExternalLink, Platform, ProjectStatus, Visibility } from '@pcu/contracts';
import type { Actor } from '../../../application/http-input.js';
import type { SerializableProject, createProjectSerializer } from './serializer.js';

export interface ProjectDetailRecord extends SerializableProject {
	creatorId: number;
	changeRequestDraft?: { id: string } | null;
}

export interface ProjectUpdatePatch {
	visibility?: Visibility;
	title?: string;
	summary?: string;
	description?: string;
	externalLinks?: ExternalLink[];
	platforms?: Platform[];
	hardwareRequirements?: string;
	isIncomplete?: boolean;
	status?: ProjectStatus;
	sortOrder?: number;
}

export interface ProjectUpdateSnapshot {
	creatorId: number;
	status: ProjectStatus;
	isChangeRequestDraft: boolean;
	isModificationEnabled: boolean;
	isMember: boolean;
}

/** Specialized locked snapshot + write contract, following #113 asset deletion. */
export interface ProjectUpdateTransaction {
	readonly snapshot: ProjectUpdateSnapshot;
	apply(patch: ProjectUpdatePatch): Promise<ProjectDetailRecord>;
}

export interface ProjectUpdateRepository {
	runProjectUpdate<T>(projectId: number, actor: Actor, operation: (tx: ProjectUpdateTransaction) => Promise<T>): Promise<T>;
}

export interface ProjectUpdateDependencies {
	repository: ProjectUpdateRepository;
	/** Early feedback before link I/O; never the authority for the write. */
	loadProjectWithAccess(actor: Actor, projectId: number): Promise<{ status: string }>;
	resolveExternalLinks(links: ExternalLink[]): Promise<ExternalLink[]>;
	serializeProjectDetail: ReturnType<typeof createProjectSerializer>['serializeProjectDetail'];
}

export type ProjectUpdate = (projectId: number, patch: ProjectUpdatePatch, actor: Actor) => Promise<
	ReturnType<ProjectUpdateDependencies['serializeProjectDetail']> & {
		isModificationEnabled: boolean;
		canEdit: boolean;
		canChangeVisibility: boolean;
		canDelete: boolean;
		canRequestChange: boolean;
		canEditWebglDisplay: boolean;
	}
>;
