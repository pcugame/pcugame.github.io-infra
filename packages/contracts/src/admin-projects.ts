import type { AssetKind, AssetPlaybackStatus, Platform, ProjectStatus } from './enums.js';
import type { ProjectVideo } from './public.js';
import type { ResponsiveImage } from './responsive-image.js';
import type { ProjectAttachment } from './public.js';

export type UpdateProjectRequest = {
	title?: string;
	summary?: string;
	description?: string;
	isIncomplete?: boolean;
	status?: Exclude<ProjectStatus, 'DRAFT'>;
	sortOrder?: number;
};

export type AdminProjectItem = {
	isModificationEnabled?: boolean;
	canEdit?: boolean;
	canDelete?: boolean;
	canRequestChange?: boolean;
	id: number;
	title: string;
	slug: string;
	year: number;
	isIncomplete: boolean;
	status: ProjectStatus;
	createdByUserName?: string;
	memberNames: string[];
	memberStudentIds: string[];
	updatedAt: string;
};

export type AdminProjectListSort = 'createdAt' | 'title' | 'year' | 'status';
export type SortOrder = 'asc' | 'desc';

export type AdminProjectListQuery = {
	page?: number;
	limit?: number;
	search?: string;
	year?: number;
	status?: ProjectStatus;
	sort?: AdminProjectListSort;
	order?: SortOrder;
};

export type BulkUpdateProjectStatusRequest = {
	ids: number[];
	status: Exclude<ProjectStatus, 'DRAFT'>;
};

export type BulkDeleteProjectsRequest = {
	ids: number[];
};

export type SetProjectPosterRequest = {
	assetId: number;
};

export type PaginationInfo = {
	page: number;
	limit: number;
	totalItems: number;
	totalPages: number;
	hasNextPage: boolean;
	hasPreviousPage: boolean;
};

export type AdminProjectListResponse = {
	items: AdminProjectItem[];
	pagination: PaginationInfo;
};

export type AdminProjectDetail = {
	isModificationEnabled?: boolean;
	canEdit?: boolean;
	canDelete?: boolean;
	canRequestChange?: boolean;
	id: number;
	title: string;
	slug: string;
	year: number;
	summary?: string;
	description?: string;
	githubUrl?: string;
	platforms: Platform[];
	isIncomplete: boolean;
	video: ProjectVideo | null;
	videos: ProjectVideo[];
	status: ProjectStatus;
	sortOrder: number;
	posterAssetId?: number;
	poster?: ResponsiveImage;
	webglUrl?: string;
	webglDeployment?: {
		id: string;
		url: string;
		createdAt: string;
	};
	members: { id: number; name: string; studentId: string; sortOrder: number; userId: number | null }[];
	assets: Array<({
		id: number;
		kind: Extract<AssetKind, 'THUMBNAIL' | 'IMAGE' | 'POSTER'>;
		image: ResponsiveImage;
		originalName: string;
		size: number;
	} | {
		id: number;
		kind: Extract<AssetKind, 'GAME' | 'VIDEO'>;
		videoSortOrder?: number | null;
		url: string;
		originalDownloadUrl?: string;
		playbackUrl?: string;
		playbackStatus?: AssetPlaybackStatus;
		playbackError?: string;
		originalName: string;
		size: number;
	} | {
		id: number;
		kind: Extract<AssetKind, 'DOCUMENT' | 'ATTACHMENT'>;
		originalName: string;
		mimeType: string;
		size: number;
		downloadUrl: string;
	})>;
	/** Omitted by older API releases; clients treat it as an empty list. */
	attachments?: ProjectAttachment[];
};

export type SubmitProjectPayload = {
	exhibitionId: number;
	title: string;
	summary?: string;
	description?: string;
	members: { name: string; studentId: string; sortOrder?: number; userId?: number }[];
	manifest: ProjectSubmissionManifestItem[];
};

export type ProjectSubmissionManifestItem = {
	kind: 'GAME' | 'WEBGL' | 'VIDEO' | 'IMAGE' | 'POSTER' | 'DOCUMENT' | 'ATTACHMENT';
	slot: string;
	clientToken: string;
	required: true;
};

export type ProjectSubmissionItemStatus = ProjectSubmissionManifestItem & {
	id: string;
	state: 'EXPECTED' | 'UPLOADING' | 'VERIFYING' | 'READY' | 'FAILED' | 'CANCELLED';
	sessionId?: string;
	generation?: number;
	failureReason?: string;
	playbackState?: 'READY' | 'FAILED';
	playbackError?: string;
};

export type ProjectSubmissionStatusResponse = {
	submissionId: string;
	projectId: number;
	projectStatus: ProjectStatus;
	state: 'PENDING' | 'FINALIZING' | 'PUBLISHED' | 'CANCELLED';
	publicationState?: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
	publicationError?: string;
	items: ProjectSubmissionItemStatus[];
};

export type ProjectSubmissionAuditResponse = {
	draftProjects: number;
	pendingSubmissions: number;
	finalizingSubmissions: number;
	activePublicationJobs: number;
};

export type SubmitProjectResponse = {
	id: number;
	slug: string;
	year: number;
	status: 'DRAFT';
	submissionId: string;
	items: ProjectSubmissionItemStatus[];
	adminEditUrl: string;
	publicUrl?: string;
};

export type AddMemberRequest = {
	name: string;
	studentId: string;
	sortOrder?: number;
};

export type UpdateMemberRequest = {
	name?: string;
	studentId?: string;
	sortOrder?: number;
};

export type SwapProjectMembersRequest = {
	memberIdA: number;
	memberIdB: number;
};

export type SetProjectVideoOrderRequest = { expectedOrder: number[]; order: number[] };
