// Shared API contract types between apps/api and apps/web.
// Type-only — no runtime values. Each consumer declares its own runtime
// constants (e.g. enum value arrays for form options) where needed.

// ── Enums ────────────────────────────────────────────────────

export type UserRole = 'USER' | 'OPERATOR' | 'ADMIN';
export type ProjectStatus = 'PUBLISHED' | 'ARCHIVED';
export type AssetKind = 'THUMBNAIL' | 'IMAGE' | 'POSTER' | 'GAME' | 'VIDEO';
export type AssetPlaybackStatus = 'PENDING' | 'READY' | 'FAILED';
export type Platform = 'PC' | 'MOBILE' | 'WEB';

// ── Auth ─────────────────────────────────────────────────────

/** POST /api/auth/google – request */
export type GoogleAuthRequest = {
	credential: string;
};

/** Authenticated user */
export type AuthUser = {
	id: number;
	email: string;
	name: string;
	role: UserRole;
	studentId?: string;
};

/** POST /api/auth/google – response (data envelope stripped) */
export type GoogleAuthResponse = {
	user: AuthUser;
};

export type DevAuthLoginRequest = {
	role: UserRole;
};

export type DevAuthErrorScenario =
	| 'domain-not-allowed'
	| 'google-api-unavailable'
	| 'invalid-google-token'
	| 'missing-google-payload'
	| 'api-server-error';

export type DevAuthLoginErrorRequest = {
	scenario: DevAuthErrorScenario;
};

/** POST /api/auth/logout – response */
export type LogoutResponse = { message: string };

/** GET /api/me – response */
export type MeResponse =
	| { authenticated: false }
	| { authenticated: true; user: AuthUser };

// ── Public ───────────────────────────────────────────────────

/** GET /api/public/years */
export type PublicYearItem = {
	id: number;
	year: number;
	title?: string;
	projectCount: number;
	posterUrl?: string;
};

export type PublicYearListResponse = {
	items: PublicYearItem[];
};

/** GET /api/public/years/:year/projects */
export type PublicProjectCard = {
	id: number;
	slug: string;
	title: string;
	summary?: string;
	posterUrl?: string;
	members: { name: string; studentId: string }[];
	exhibitionId?: number;
	exhibitionTitle?: string;
};

export type PublicExhibition = {
	id: number;
	title: string;
};

export type PublicYearProjectsResponse = {
	year: number;
	exhibitions: PublicExhibition[];
	items: PublicProjectCard[];
	empty: boolean;
};

/** GET /api/public/exhibitions/:id/projects */
export type PublicExhibitionProjectsResponse = {
	exhibition: { id: number; year: number; title: string };
	items: PublicProjectCard[];
	empty: boolean;
};

/** Project video (locally uploaded) */
export type ProjectVideo = {
	url: string;
	mimeType: string;
	originalDownloadUrl?: string;
	playbackStatus?: AssetPlaybackStatus;
	playbackError?: string;
};

/** GET /api/public/projects/:idOrSlug */
export type PublicProjectImage = {
	id: number;
	url: string;
	kind: 'IMAGE' | 'POSTER';
};

export type PublicProjectMember = {
	id: number;
	name: string;
	studentId: string;
};

export type PublicProjectDetailResponse = {
	id: number;
	year: number;
	slug: string;
	title: string;
	summary?: string;
	description?: string;
	githubUrl?: string;
	platforms: Platform[];
	isIncomplete: boolean;
	video: ProjectVideo | null;
	videos: ProjectVideo[];
	members: PublicProjectMember[];
	images: PublicProjectImage[];
	posterUrl?: string;
	gameDownloadUrl?: string;
	status: 'PUBLISHED' | 'ARCHIVED';
};

// ── Admin: Exhibition ────────────────────────────────────────

export type CreateExhibitionRequest = {
	year: number;
	title?: string;
	isUploadEnabled?: boolean;
	sortOrder?: number;
};

export type UpdateExhibitionRequest = {
	title?: string;
	isUploadEnabled?: boolean;
	sortOrder?: number;
};

export type AdminExhibitionItem = {
	id: number;
	year: number;
	title?: string;
	isUploadEnabled: boolean;
	sortOrder: number;
	projectCount: number;
	posterUrl?: string;
	posterOriginalName?: string;
	posterSize?: number;
};

// ── Admin: Project ───────────────────────────────────────────

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

// ── Admin: Submit (all-in-one) ───────────────────────────────

export type SubmitProjectPayload = {
	exhibitionId: number;
	title: string;
	summary?: string;
	description?: string;
	members: { name: string; studentId: string; sortOrder?: number }[];
};

export type SubmitProjectResponse = {
	id: number;
	slug: string;
	year: number;
	status: 'PUBLISHED';
	adminEditUrl: string;
	publicUrl?: string;
};

// ── Admin: Member CRUD ───────────────────────────────────────

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

// ── Admin: Settings ─────────────────────────────────────────

export type SiteSettingsData = {
	maxGameFileMb: number;
	maxChunkSizeMb: number;
};

export type UpdateSiteSettingsRequest = Partial<SiteSettingsData>;

// ── Admin: Banned IPs ───────────────────────────────────────

export type BannedIpItem = {
	id: number;
	ip: string;
	reason: string;
	createdAt: string;
};

export type BannedIpListResponse = {
	items: BannedIpItem[];
};

// ── Admin: Import ───────────────────────────────────────────

export type ImportPreviewExhibition = {
	year: number;
	title: string;
	isNew: boolean;
	existingProjectCount: number;
};

export type ImportPreviewResult = {
	valid: boolean;
	exhibitions: ImportPreviewExhibition[];
	projectCount: number;
	errors: string[];
};

export type ImportExecuteResult = {
	exhibitions: { created: number; existing: number };
	projects: { created: number };
};

// ── Admin: Export progress ───────────────────────────────────

export type ExportPhase = 'preparing' | 'downloading' | 'finishing';
export type ExportFileStatus = 'pending' | 'saving' | 'saved' | 'skipped' | 'failed';

export type ExportProgressFile = {
	assetId: number;
	kind: AssetKind;
	originalName: string;
	fileName: string;
	status: ExportFileStatus;
};

export type ExportProgress = {
	year: number | null;
	startedAt: number;
	phase: ExportPhase;
	totalProjects: number;
	currentProjectIndex: number;
	currentProjectTitle: string | null;
	currentProjectFiles: ExportProgressFile[];
	totalFiles: number;
	downloaded: number;
	skipped: number;
	failed: number;
};

/** GET /api/admin/export/status */
export type ExportStatusResponse = {
	running: boolean;
	progress: ExportProgress | null;
};

export type ExportResult = {
	projects: number;
	totalFiles: number;
	downloaded: number;
	skipped: number;
	failed: number;
	aborted: boolean;
	paths: string[];
};

// ── Admin: Game upload ──────────────────────────────────────

export type GameUploadSession = {
	sessionId: string;
	chunkSizeBytes: number;
	totalChunks: number;
	expiresAt: string;
};

export type GameUploadStatus = {
	sessionId: string;
	projectId: number;
	originalName: string;
	totalBytes: number;
	chunkSizeBytes: number;
	totalChunks: number;
	uploadedChunks: number[];
	uploadedCount: number;
	status: string;
	expiresAt: string;
};

export type GameUploadSessionListResponse = {
	items: GameUploadStatus[];
};

export type GameUploadChunkResponse = {
	index: number;
	bytesWritten: number;
	uploadedCount: number;
	totalChunks: number;
};

export type GameUploadCompleteResponse = {
	status: 'COMPLETED';
	storageKey: string;
	sizeBytes: number;
};
