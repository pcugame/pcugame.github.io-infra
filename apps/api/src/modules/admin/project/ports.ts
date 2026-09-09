import type {
	AssetKind,
	ProjectStatus,
} from '@pcu/contracts';
import type { PosterCandidate } from '../../../shared/poster-validation.js';
import type { SerializableProject } from './serializer.js';
import type { Actor } from '../../../application/http-input.js';

export interface ExhibitionUploadRecord {
	id: number;
	year: number;
	title: string;
	isModificationEnabled: boolean;
}

export interface SubmitProjectWriteData {
	exhibitionId: number;
	slug: string;
	title: string;
	summary?: string;
	description?: string;
	status: ProjectStatus;
	creatorId: number;
	members: Array<{
		name: string;
		studentId: string;
		sortOrder?: number;
		userId?: number;
	}>;
	manifest: Array<{
		kind: 'GAME' | 'WEBGL' | 'VIDEO' | 'IMAGE' | 'POSTER' | 'DOCUMENT' | 'ATTACHMENT';
		slot: string;
		clientToken: string;
		required: true;
	}>;
	idempotency?: {
		operationId: string;
		ownerToken: string;
		resultForProject(project: {
			id: number;
			slug: string;
			submission: ProjectSubmissionRecord;
		}): Record<string, unknown>;
	};
}

export interface ProjectSubmissionRecord {
	id: string;
	projectId: number;
	actorId: number;
	state: 'PENDING' | 'FINALIZING' | 'PUBLISHED' | 'CANCELLED';
	project: { id: number; status: ProjectStatus };
	items: Array<{
		id: string;
		kind: 'GAME' | 'WEBGL' | 'VIDEO' | 'IMAGE' | 'POSTER' | 'DOCUMENT' | 'ATTACHMENT';
		slot: string;
		clientToken: string;
		required: boolean;
		state: 'EXPECTED' | 'UPLOADING' | 'VERIFYING' | 'READY' | 'FAILED' | 'CANCELLED';
		boundGeneration: number | null;
		failureReason: string | null;
		playbackState: 'NONE' | 'READY' | 'FAILED';
		playbackError: string | null;
		uploadSession: { id: string; generation: number } | null;
	}>;
	publicationJob: { state: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'; lastError: string | null } | null;
}

export interface ProjectListRecord {
	id: number;
	title: string;
	slug: string;
	exhibition: { year: number; isModificationEnabled?: boolean };
	isIncomplete: boolean;
	status: ProjectStatus;
	creatorId: number;
	creator: { name: string };
	members: Array<{ name: string; studentId: string; userId: number | null }>;
	updatedAt: Date;
	assets: Array<{ kind: AssetKind }>;
	poster: {
		kind: AssetKind;
		status: string;
		representations?: Array<{ role: string; objectKey: string }>;
	} | null;
}

export interface ProjectDetailRecord extends SerializableProject {
	creatorId: number;
	changeRequestDraft?: { id: string } | null;
}

export interface ActiveUploadCleanup {
	projectId?: number;
	uploadKind: string;
	objectKey: string | null;
	uploadId: string | null;
}

export interface DeletedAssetRecord {
	id: number;
	projectId: number | null;
	kind: AssetKind;
	representations: Array<{ role: string; bucket: string; objectKey: string }>;
}

export interface DeletionOutboxConfig {
	publicBucket: string;
	protectedBucket: string;
	reason: string;
}

export interface ProjectRepository {
	findProjectsForUser(
		userId: number,
		isPrivileged: boolean,
		options: {
			page: number;
			limit: number;
			search?: string;
			year?: number;
			status?: ProjectStatus;
			sort: 'createdAt' | 'title' | 'year' | 'status';
			order: 'asc' | 'desc';
		},
	): Promise<{ items: ProjectListRecord[]; totalItems: number }>;
	findProjectById(id: number): Promise<ProjectDetailRecord | null>;
	isMemberOfProject(projectId: number, userId: number): Promise<unknown | null>;
	updateProject(id: number, patch: {
		title?: string;
		summary?: string;
		description?: string;
		isIncomplete?: boolean;
		status?: ProjectStatus;
		sortOrder?: number;
	}, actor?: Actor): Promise<ProjectDetailRecord>;
	deleteProjectReturningAssets(id: number, outbox: DeletionOutboxConfig, actor?: Actor): Promise<{
		assets: DeletedAssetRecord[];
		activeUploads: ActiveUploadCleanup[];
	}>;
	clearWebglDeployment(projectId: number, outbox: DeletionOutboxConfig, actor?: Actor): Promise<{
		cancelledSession: ActiveUploadCleanup | null;
	}>;
	findAssetById(id: number): Promise<PosterCandidate | null>;
	setProjectVideoOrder(projectId: number, expectedOrder: number[], order: number[], actor?: Actor): Promise<{ order: number[] }>;
	setProjectPoster(projectId: number, assetId: number, actor?: Actor): Promise<unknown>;
	bulkDeleteProjectsReturningAssets(ids: number[], outbox: DeletionOutboxConfig): Promise<{
		result: { count: number };
		assets: DeletedAssetRecord[];
		projects: Array<{ id: number; currentWebglDeploymentId: string | null }>;
		activeUploads: Array<ActiveUploadCleanup & { projectId: number }>;
	}>;

	findExhibitionById(id: number): Promise<ExhibitionUploadRecord | null>;
	findProjectByExhibitionAndSlug(exhibitionId: number, slug: string): Promise<unknown | null>;
	createProjectWithAssets(data: SubmitProjectWriteData): Promise<{
		id: number;
		slug: string;
		submission: ProjectSubmissionRecord;
	}>;
	findSubmissionForActor(projectId: number, actor: { id: number; role: string }): Promise<ProjectSubmissionRecord | null>;
	finalizeSubmission(projectId: number, actor: { id: number; role: string }): Promise<ProjectSubmissionRecord>;
	cancelSubmission(projectId: number, actor: { id: number; role: string }): Promise<ProjectSubmissionRecord>;
	auditActiveSubmissions(): Promise<{ draftProjects: number; pendingSubmissions: number; finalizingSubmissions: number; activePublicationJobs: number }>;
}

export type ProjectCrudRepository = Pick<ProjectRepository,
	| 'bulkDeleteProjectsReturningAssets'
	| 'clearWebglDeployment'
	| 'deleteProjectReturningAssets'
	| 'findAssetById'
	| 'findProjectById'
	| 'findProjectsForUser'
	| 'isMemberOfProject'
	| 'setProjectPoster'
	| 'setProjectVideoOrder'
	| 'updateProject'
>;

export type SubmitProjectRepository = Pick<ProjectRepository,
	'auditActiveSubmissions' | 'cancelSubmission' | 'createProjectWithAssets' | 'finalizeSubmission' | 'findExhibitionById' | 'findProjectByExhibitionAndSlug' | 'findSubmissionForActor'
>;

/** Complete application-facing project port assembled once by BackendContext. */
export type ProjectApplicationRepository = ProjectCrudRepository
	& SubmitProjectRepository
	& {
		bulkUpdateStatus(ids: number[], status: ProjectStatus): Promise<{ count: number }>;
	};
