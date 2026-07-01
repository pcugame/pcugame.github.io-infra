// Shared API contract types between apps/api and apps/web.
// Type-only — no runtime values. Each consumer declares its own runtime
// constants (e.g. enum value arrays for form options) where needed.

export type { AssetKind, AssetPlaybackStatus, Platform, ProjectStatus, UserRole } from './enums.js';

export type {
	ApiErrorCode,
	AuthUser,
	DevAuthErrorScenario,
	DevAuthLoginErrorRequest,
	DevAuthLoginRequest,
	GoogleAuthRequest,
	GoogleAuthResponse,
	LogoutResponse,
	MeResponse,
} from './auth.js';

export type {
	ProjectVideo,
	PublicExhibition,
	PublicExhibitionProjectsResponse,
	PublicProjectCard,
	PublicProjectDetailResponse,
	PublicProjectImage,
	PublicProjectMember,
	PublicYearItem,
	PublicYearListResponse,
	PublicYearProjectsResponse,
} from './public.js';

export type {
	AdminExhibitionItem,
	CreateExhibitionRequest,
	UpdateExhibitionRequest,
} from './admin-exhibitions.js';

export type {
	AddMemberRequest,
	AdminProjectDetail,
	AdminProjectItem,
	AdminProjectListQuery,
	AdminProjectListResponse,
	AdminProjectListSort,
	PaginationInfo,
	SortOrder,
	SubmitProjectPayload,
	SubmitProjectResponse,
	UpdateMemberRequest,
	UpdateProjectRequest,
} from './admin-projects.js';

export type {
	BannedIpItem,
	BannedIpListResponse,
	SiteSettingsData,
	UpdateSiteSettingsRequest,
} from './admin-settings.js';

export type {
	ExportFileStatus,
	ExportPhase,
	ExportProgress,
	ExportProgressFile,
	ExportResult,
	ExportStatusResponse,
	ImportExecuteResult,
	ImportPreviewExhibition,
	ImportPreviewResult,
} from './admin-import-export.js';

export type {
	GameUploadChunkResponse,
	GameUploadCompleteResponse,
	GameUploadSession,
	GameUploadSessionListResponse,
	GameUploadStatus,
} from './game-upload.js';
