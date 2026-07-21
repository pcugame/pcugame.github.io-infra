import type {
	AssetKind,
	AssetPlaybackStatus,
	ProjectStatus,
} from '@pcu/contracts';
import type { PosterCandidate } from '../../../shared/poster-validation.js';
import type { SerializableProject } from './serializer.js';

export interface ExhibitionUploadRecord {
	id: number;
	year: number;
	title: string;
	isUploadEnabled: boolean;
}

export interface AssetWriteData {
	storageKey: string;
	playbackStorageKey?: string | null;
	originalName: string;
	mimeType: string;
	playbackMimeType?: string;
	sizeBytes: bigint;
	playbackSizeBytes?: bigint;
	playbackStatus?: AssetPlaybackStatus;
	playbackError?: string;
	isPublic: boolean;
}

export interface ProjectAssetWriteData extends AssetWriteData {
	projectId: number;
	kind: AssetKind;
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
	savedFiles: Array<{
		kind: AssetKind;
		storageKey: string;
		playbackStorageKey?: string | null;
		originalName: string;
		mimeType: string;
		playbackMimeType?: string;
		sizeBytes: number;
		playbackSizeBytes?: number;
		playbackStatus?: AssetPlaybackStatus;
		playbackError?: string;
	}>;
}

export interface ProjectListRecord {
	id: number;
	title: string;
	slug: string;
	exhibition: { year: number };
	isIncomplete: boolean;
	status: ProjectStatus;
	creator: { name: string };
	members: Array<{ name: string; studentId: string }>;
	updatedAt: Date;
	assets: Array<{ kind: AssetKind }>;
	poster: { kind: AssetKind; status: string; storageKey: string } | null;
}

export interface ProjectDetailRecord extends SerializableProject {
	creatorId: number;
}

export interface ActiveUploadCleanup {
	projectId?: number;
	uploadKind: string;
	s3Key: string | null;
	s3UploadId: string | null;
}

export interface DeletedAssetRecord {
	id: number;
	projectId: number;
	kind: AssetKind;
	storageKey: string;
	playbackStorageKey: string | null;
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
	}): Promise<ProjectDetailRecord>;
	deleteProjectReturningAssets(id: number): Promise<{
		assets: DeletedAssetRecord[];
		webglEntryKey: string;
		activeUploads: ActiveUploadCleanup[];
	}>;
	clearWebglDeployment(projectId: number): Promise<{
		oldEntryKey: string;
		cancelledSession: ActiveUploadCleanup | null;
	}>;
	findAssetById(id: number): Promise<PosterCandidate | null>;
	setProjectPoster(projectId: number, assetId: number): Promise<unknown>;
	bulkDeleteProjectsReturningAssets(ids: number[]): Promise<{
		result: { count: number };
		assets: DeletedAssetRecord[];
		projects: Array<{ id: number; webglEntryKey: string }>;
		activeUploads: Array<ActiveUploadCleanup & { projectId: number }>;
	}>;

	findExhibitionById(id: number): Promise<ExhibitionUploadRecord | null>;
	findProjectByExhibitionAndSlug(exhibitionId: number, slug: string): Promise<unknown | null>;
	createProjectWithAssets(data: SubmitProjectWriteData): Promise<{ id: number; slug: string }>;
	createAsset(data: ProjectAssetWriteData): Promise<{ id: number }>;
	replaceOrCreateReplaceableAsset(
		projectId: number,
		kind: AssetKind,
		data: AssetWriteData,
	): Promise<{
		assetId: number;
		oldStorageKey: string | null;
		oldPlaybackStorageKey: string | null;
	}>;
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
	| 'updateProject'
>;

export type SubmitProjectRepository = Pick<ProjectRepository,
	'createProjectWithAssets' | 'findExhibitionById' | 'findProjectByExhibitionAndSlug'
>;

export type ProjectAssetRepository = Pick<ProjectRepository,
	'createAsset' | 'findExhibitionById' | 'replaceOrCreateReplaceableAsset'
>;
