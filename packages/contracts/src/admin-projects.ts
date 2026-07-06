import type { AssetKind, AssetPlaybackStatus, Platform, ProjectStatus } from './enums.js';
import type { ProjectVideo } from './public.js';

export type UpdateProjectRequest = {
	title?: string;
	summary?: string;
	description?: string;
	isIncomplete?: boolean;
	status?: ProjectStatus;
	sortOrder?: number;
};

export type AdminProjectItem = {
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
	status: ProjectStatus;
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
	posterUrl?: string;
	members: { id: number; name: string; studentId: string; sortOrder: number; userId: number | null }[];
	assets: {
		id: number;
		kind: AssetKind;
		url: string;
		originalDownloadUrl?: string;
		playbackUrl?: string;
		playbackStatus?: AssetPlaybackStatus;
		playbackError?: string;
		originalName: string;
		size: number;
	}[];
};

export type SubmitProjectPayload = {
	exhibitionId: number;
	title: string;
	summary?: string;
	description?: string;
	members: { name: string; studentId: string; sortOrder?: number; userId?: number }[];
};

export type SubmitProjectResponse = {
	id: number;
	slug: string;
	year: number;
	status: 'PUBLISHED';
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
