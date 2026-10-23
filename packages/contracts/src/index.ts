// Shared API contract types and runtime transport schemas between apps/api and apps/web.

export type { AssetKind, AssetPlaybackStatus, Platform, ProjectStatus, UserRole, Visibility } from './enums.js';
export { RESPONSIVE_IMAGE_PROFILES } from './responsive-image.js';
export type { ResponsiveImageProfile } from './responsive-image.js';

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
	DirectGameUploadCompletionResponse,
	DirectGameUploadCompleteRequest,
	DirectGameUploadCreateSessionRequest,
	DirectAssetUploadStatus,
	DirectAssetUploadKind,
	DirectAssetUploadOwner,
	DirectGameUploadPart,
	DirectGameUploadPartUrlsRequest,
	DirectGameUploadPartUrlsResponse,
	DirectUploadSourceIdentity,
	UploadKind,
} from './game-upload.js';
export {
	DIRECT_UPLOAD_BROWSER_PART_BATCH_SIZE,
	DIRECT_UPLOAD_PART_CAPABILITY_BATCH_MAX,
} from './game-upload.js';

export * from './external-links.js';
export * from './schemas.js';
export * from './response-schemas.js';

export * from './project-change-schemas.js';

export { normalizeIpTarget, compileIpTarget } from './ip-target.js';

export { VisibilitySchema } from './schemas.js';
export * from './webgl-play.js';

export * from './webgl-display.js';
export * from './webgl-network.js';

export { PROJECT_PLATFORMS } from './enums.js';
export * from './project-requirements.js';

export * from './voting.js';

export * from './connection-profiles.js';
export * from './connection-draft.js';

export { DirectAssetUploadCreationSchema, DirectAssetUploadCreationLookupSchema } from './game-upload.js';
export type { DirectAssetUploadCreation, DirectAssetUploadCreationLookup } from './game-upload.js';
export * from './publication.js';

export * from './video-retry.js';
export * from './video-playback.js';

export type { CreateBannedIpRequest, UpdateSiteSettingsRequest } from './admin-settings.js';
