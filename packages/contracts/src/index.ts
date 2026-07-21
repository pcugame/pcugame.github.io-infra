// Shared API contract types and runtime transport schemas between apps/api and apps/web.

export type { AssetKind, AssetPlaybackStatus, Platform, ProjectStatus, UserRole } from './enums.js';

export {
	attachmentContentDisposition,
	buildGameDownloadFilename,
	GAME_DOWNLOAD_FALLBACK_FILENAME,
	MAX_NEW_PROJECT_TITLE_BYTES,
	MAX_PORTABLE_FILENAME_BYTES,
	sanitizeFilenameComponent,
	utf8ByteLength,
	validateUploadFilename,
} from './filename-policy.js';
export type {
	FilenameValidationReason,
	FilenameValidationReasonCode,
	GameDownloadMember,
} from './filename-policy.js';

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
	BulkDeleteProjectsRequest,
	BulkUpdateProjectStatusRequest,
	PaginationInfo,
	SetProjectPosterRequest,
	SortOrder,
	SubmitProjectPayload,
	SubmitProjectResponse,
	SwapProjectMembersRequest,
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
	ExportAssetKind,
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
	GameUploadCreateSessionRequest,
	GameUploadChunkResponse,
	GameUploadCompleteResponse,
	GameUploadSession,
	GameUploadSessionListResponse,
	GameUploadStatus,
	UploadKind,
} from './game-upload.js';

export * from './schemas.js';
