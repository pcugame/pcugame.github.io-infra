import { z } from 'zod';
import {
	AssetKindSchema,
	ProjectStatusSchema,
	UserRoleSchema,
	UploadKindSchema,
} from './schemas.js';
import type { ResponsiveImage } from './responsive-image.js';

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string(),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(JsonValueSchema),
		z.record(z.string(), JsonValueSchema),
	]),
);

export const ApiErrorCodeSchema = z.enum([
	'ERROR',
	'VALIDATION_ERROR',
	'UNAUTHORIZED',
	'EMAIL_DOMAIN_NOT_ALLOWED',
	'GOOGLE_API_UNAVAILABLE',
	'FORBIDDEN',
	'NOT_FOUND',
	'CONFLICT',
	'PAYLOAD_TOO_LARGE',
	'UNSUPPORTED_MEDIA_TYPE',
	'RATE_LIMITED',
	'IP_BANNED',
	'BANNED_IP_CACHE_UNAVAILABLE',
	'TOO_MANY_UPLOADS',
	'USER_SUBMIT_FORBIDDEN_FIELD',
	'INVALID_FILENAME',
	'DRAINING',
	'INTERNAL_ERROR',
	'SIZE_MISMATCH',
	'MULTIPART_PART_LIMIT',
	'IDEMPOTENCY_CONFLICT',
	'OPERATION_IN_PROGRESS',
]);

/**
 * Every JSON error emitted by the API uses this envelope. `statusCode` is
 * optional because @fastify/rate-limit includes it in its established 429
 * payload while application errors do not.
 */
export const ApiErrorResponseSchema = z.object({
	statusCode: z.number().int().min(100).max(599).optional(),
	ok: z.literal(false),
	error: z.object({
		code: ApiErrorCodeSchema,
		message: z.string(),
		details: JsonValueSchema.optional(),
	}).strict(),
}).strict();

export function apiSuccessSchema<TSchema extends z.ZodType>(data: TSchema) {
	return z.object({
		ok: z.literal(true),
		data,
	}).strict();
}

const PositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const NonZeroIntegerSchema = z.number()
	.int()
	.min(Number.MIN_SAFE_INTEGER)
	.max(Number.MAX_SAFE_INTEGER)
	.refine((value) => value !== 0, 'Expected a non-zero integer');
const YearSchema = z.number().int().min(1000).max(9999);
const IsoDateTimeSchema = z.string().datetime({ offset: true });
const UrlSchema = z.string().url();
// Imports historically accept an opaque GitHub/link string. Narrowing this to
// URL syntax would turn already-valid stored records into HTTP 500 responses.
const StoredProjectLinkSchema = z.string().min(1).max(500);
const AssetPlaybackStatusSchema = z.enum(['PENDING', 'READY', 'FAILED']);
const PlatformSchema = z.enum(['PC', 'MOBILE', 'WEB']);
const GameUploadStatusValueSchema = z.enum([
	'PENDING',
	'COMPLETING',
	'VERIFYING',
	'COMPLETED',
	'REJECTED',
	'CANCELLED',
	'FAILED',
	'EXPIRED',
]);
const OpaqueSessionIdSchema = z.string().min(1).max(200).refine(
	(value) => !value.includes('\0'),
	'Session ID contains a NUL byte',
);

export const ResponsiveImageSchema: z.ZodType<ResponsiveImage> = z.object({
	original: z.object({
		url: UrlSchema,
		width: PositiveIntegerSchema.optional(),
		height: PositiveIntegerSchema.optional(),
	}).strict(),
	renditions: z.array(z.object({
		profile: z.enum(['CARD_480', 'DISPLAY_960']),
		url: UrlSchema,
		width: PositiveIntegerSchema,
		height: PositiveIntegerSchema,
	}).strict()),
}).strict();

export const AuthUserSchema = z.object({
	id: PositiveIntegerSchema,
	email: z.string().min(1),
	name: z.string(),
	role: UserRoleSchema,
	studentId: z.string().optional(),
}).strict();

export const GoogleAuthResponseSchema = z.object({
	user: AuthUserSchema,
}).strict();

export const LogoutResponseSchema = z.object({
	message: z.string(),
}).strict();

export const MeResponseSchema = z.discriminatedUnion('authenticated', [
	z.object({ authenticated: z.literal(false) }).strict(),
	z.object({
		authenticated: z.literal(true),
		user: AuthUserSchema,
	}).strict(),
]);

export const PublicYearItemSchema = z.object({
	id: PositiveIntegerSchema,
	year: YearSchema,
	title: z.string().optional(),
	projectCount: NonNegativeIntegerSchema,
	poster: ResponsiveImageSchema.optional(),
}).strict();

export const PublicYearListResponseSchema = z.object({
	items: z.array(PublicYearItemSchema),
}).strict();

export const PublicProjectCardSchema = z.object({
	id: PositiveIntegerSchema,
	slug: z.string().min(1),
	title: z.string(),
	summary: z.string().optional(),
	poster: ResponsiveImageSchema.optional(),
	members: z.array(z.object({
		name: z.string(),
		studentId: z.string(),
	}).strict()),
	exhibitionId: PositiveIntegerSchema.optional(),
	exhibitionTitle: z.string().optional(),
}).strict();

export const PublicExhibitionSchema = z.object({
	id: PositiveIntegerSchema,
	title: z.string(),
}).strict();

export const PublicYearProjectsResponseSchema = z.object({
	year: YearSchema,
	exhibitions: z.array(PublicExhibitionSchema),
	items: z.array(PublicProjectCardSchema),
	empty: z.boolean(),
}).strict();

export const PublicExhibitionProjectsResponseSchema = z.object({
	exhibition: z.object({
		id: PositiveIntegerSchema,
		year: YearSchema,
		title: z.string(),
	}).strict(),
	items: z.array(PublicProjectCardSchema),
	empty: z.boolean(),
}).strict();

export const ProjectVideoSchema = z.object({
	url: UrlSchema,
	mimeType: z.string().min(1),
	originalDownloadUrl: UrlSchema.optional(),
	playbackStatus: AssetPlaybackStatusSchema.optional(),
	playbackError: z.string().optional(),
}).strict();

export const PublicProjectImageSchema = z.object({
	id: PositiveIntegerSchema,
	kind: z.enum(['IMAGE', 'POSTER']),
	image: ResponsiveImageSchema,
}).strict();

export const PublicProjectMemberSchema = z.object({
	id: PositiveIntegerSchema,
	name: z.string(),
	studentId: z.string(),
}).strict();

export const PublicProjectDetailResponseSchema = z.object({
	id: PositiveIntegerSchema,
	year: YearSchema,
	slug: z.string().min(1),
	title: z.string(),
	summary: z.string().optional(),
	description: z.string().optional(),
	githubUrl: StoredProjectLinkSchema.optional(),
	platforms: z.array(PlatformSchema),
	isIncomplete: z.boolean(),
	video: ProjectVideoSchema.nullable(),
	videos: z.array(ProjectVideoSchema),
	members: z.array(PublicProjectMemberSchema),
	images: z.array(PublicProjectImageSchema),
	poster: ResponsiveImageSchema.optional(),
	gameDownloadUrl: UrlSchema.optional(),
	webglUrl: UrlSchema.optional(),
	status: ProjectStatusSchema,
}).strict();

export const AdminExhibitionItemSchema = z.object({
	id: PositiveIntegerSchema,
	year: YearSchema,
	title: z.string().optional(),
	isUploadEnabled: z.boolean(),
	sortOrder: NonNegativeIntegerSchema,
	projectCount: NonNegativeIntegerSchema,
	poster: ResponsiveImageSchema.optional(),
	posterOriginalName: z.string().optional(),
	posterSize: NonNegativeIntegerSchema.optional(),
}).strict();

export const AdminExhibitionListResponseSchema = z.object({
	items: z.array(AdminExhibitionItemSchema),
}).strict();

export const CreateExhibitionResponseSchema = z.object({
	id: PositiveIntegerSchema,
	year: YearSchema,
}).strict();

export const AdminProjectItemSchema = z.object({
	id: PositiveIntegerSchema,
	title: z.string(),
	slug: z.string().min(1),
	year: YearSchema,
	isIncomplete: z.boolean(),
	status: ProjectStatusSchema,
	createdByUserName: z.string().optional(),
	memberNames: z.array(z.string()),
	memberStudentIds: z.array(z.string()),
	updatedAt: IsoDateTimeSchema,
}).strict();

export const PaginationInfoSchema = z.object({
	page: PositiveIntegerSchema,
	limit: PositiveIntegerSchema,
	totalItems: NonNegativeIntegerSchema,
	totalPages: NonNegativeIntegerSchema,
	hasNextPage: z.boolean(),
	hasPreviousPage: z.boolean(),
}).strict();

export const AdminProjectListResponseSchema = z.object({
	items: z.array(AdminProjectItemSchema),
	pagination: PaginationInfoSchema,
}).strict();

export const AdminProjectDetailSchema = z.object({
	id: PositiveIntegerSchema,
	title: z.string(),
	slug: z.string().min(1),
	year: YearSchema,
	summary: z.string().optional(),
	description: z.string().optional(),
	githubUrl: StoredProjectLinkSchema.optional(),
	platforms: z.array(PlatformSchema),
	isIncomplete: z.boolean(),
	video: ProjectVideoSchema.nullable(),
	videos: z.array(ProjectVideoSchema),
	status: ProjectStatusSchema,
	sortOrder: NonNegativeIntegerSchema,
	posterAssetId: PositiveIntegerSchema.optional(),
	poster: ResponsiveImageSchema.optional(),
	webglUrl: UrlSchema.optional(),
	members: z.array(z.object({
		id: PositiveIntegerSchema,
		name: z.string(),
		studentId: z.string(),
		sortOrder: NonNegativeIntegerSchema,
		userId: PositiveIntegerSchema.nullable(),
	}).strict()),
	assets: z.array(z.discriminatedUnion('kind', [
		z.object({
			id: PositiveIntegerSchema,
			kind: z.enum(['THUMBNAIL', 'IMAGE', 'POSTER']),
			image: ResponsiveImageSchema,
			originalName: z.string(),
			size: NonNegativeIntegerSchema,
		}).strict(),
		z.object({
			id: PositiveIntegerSchema,
			kind: z.enum(['GAME', 'VIDEO']),
			url: UrlSchema,
			originalDownloadUrl: UrlSchema.optional(),
			playbackUrl: UrlSchema.optional(),
			playbackStatus: AssetPlaybackStatusSchema.optional(),
			playbackError: z.string().optional(),
			originalName: z.string(),
			size: NonNegativeIntegerSchema,
		}).strict(),
	])),
}).strict();

export const SubmitProjectResponseSchema = z.object({
	id: PositiveIntegerSchema,
	slug: z.string().min(1),
	year: YearSchema,
	status: z.literal('PUBLISHED'),
	adminEditUrl: UrlSchema,
	publicUrl: UrlSchema.optional(),
}).strict();

export const ProjectAssetUploadResponseSchema = z.object({
	assetId: PositiveIntegerSchema,
}).strict();

export const BulkStatusResponseSchema = z.object({
	updated: NonNegativeIntegerSchema,
}).strict();

export const BulkDeleteResponseSchema = z.object({
	deleted: NonNegativeIntegerSchema,
	assetsRemoved: NonNegativeIntegerSchema,
	webglBuildsRemoved: NonNegativeIntegerSchema,
}).strict();

export const SetProjectPosterResponseSchema = z.object({
	posterAssetId: PositiveIntegerSchema,
}).strict();

export const CreatedMemberResponseSchema = z.object({
	id: PositiveIntegerSchema,
}).strict();

export const SiteSettingsDataSchema = z.object({
	maxGameFileMb: PositiveIntegerSchema,
	maxChunkSizeMb: z.number().int().min(5),
}).strict();

export const BannedIpItemSchema = z.object({
	id: PositiveIntegerSchema,
	ip: z.string().min(1),
	reason: z.string(),
	createdAt: IsoDateTimeSchema,
}).strict();

export const BannedIpListResponseSchema = z.object({
	items: z.array(BannedIpItemSchema),
}).strict();

export const ImportPreviewExhibitionSchema = z.object({
	year: YearSchema,
	title: z.string(),
	isNew: z.boolean(),
	existingProjectCount: NonNegativeIntegerSchema,
}).strict();

export const ImportPreviewResultSchema = z.object({
	valid: z.boolean(),
	exhibitions: z.array(ImportPreviewExhibitionSchema),
	projectCount: NonNegativeIntegerSchema,
	errors: z.array(z.string()),
}).strict();

export const ImportExecuteResultSchema = z.object({
	exhibitions: z.object({
		created: NonNegativeIntegerSchema,
		existing: NonNegativeIntegerSchema,
	}).strict(),
	projects: z.object({
		created: NonNegativeIntegerSchema,
	}).strict(),
}).strict();

export const ExportProgressFileSchema = z.object({
	// WebGL exports use `-project.id` as their stable synthetic progress key.
	assetId: NonZeroIntegerSchema,
	kind: z.union([AssetKindSchema, z.literal('WEBGL')]),
	originalName: z.string(),
	fileName: z.string(),
	status: z.enum(['pending', 'saving', 'saved', 'skipped', 'failed']),
}).strict();

export const ExportProgressSchema = z.object({
	year: YearSchema.nullable(),
	startedAt: NonNegativeIntegerSchema,
	phase: z.enum(['preparing', 'downloading', 'finishing']),
	totalProjects: NonNegativeIntegerSchema,
	currentProjectIndex: NonNegativeIntegerSchema,
	currentProjectTitle: z.string().nullable(),
	currentProjectFiles: z.array(ExportProgressFileSchema),
	totalFiles: NonNegativeIntegerSchema,
	downloaded: NonNegativeIntegerSchema,
	skipped: NonNegativeIntegerSchema,
	failed: NonNegativeIntegerSchema,
}).strict();

export const ExportStatusResponseSchema = z.object({
	running: z.boolean(),
	progress: ExportProgressSchema.nullable(),
	jobId: z.string().optional(),
	result: z.lazy(() => ExportResultSchema).nullable().optional(),
	error: z.string().nullable().optional(),
}).strict();

export const ExportResultSchema = z.object({
	projects: NonNegativeIntegerSchema,
	totalFiles: NonNegativeIntegerSchema,
	downloaded: NonNegativeIntegerSchema,
	skipped: NonNegativeIntegerSchema,
	failed: NonNegativeIntegerSchema,
	aborted: z.boolean(),
	paths: z.array(z.string()),
}).strict();

export const GameUploadSessionSchema = z.object({
	sessionId: OpaqueSessionIdSchema,
	chunkSizeBytes: PositiveIntegerSchema,
	totalChunks: PositiveIntegerSchema,
	expiresAt: IsoDateTimeSchema,
	uploadKind: UploadKindSchema,
	generation: PositiveIntegerSchema,
	sourceIdentityAlgorithm: z.literal('SHA256_BLOCK_MANIFEST_V1'),
	sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/),
	sourceIdentityBlockSizeBytes: z.literal(1048576),
}).strict();

export const GameUploadStatusSchema = z.object({
	sessionId: OpaqueSessionIdSchema,
	projectId: PositiveIntegerSchema,
	uploadKind: UploadKindSchema,
	generation: PositiveIntegerSchema,
	originalName: z.string().min(1),
	totalBytes: PositiveIntegerSchema,
	chunkSizeBytes: PositiveIntegerSchema,
	totalChunks: PositiveIntegerSchema,
	uploadedCount: NonNegativeIntegerSchema,
	status: GameUploadStatusValueSchema,
	expiresAt: IsoDateTimeSchema,
	sourceIdentityAlgorithm: z.literal('SHA256_BLOCK_MANIFEST_V1').nullable(),
	sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
	sourceIdentityBlockSizeBytes: z.literal(1048576).nullable(),
	parts: z.array(z.object({
		partNumber: PositiveIntegerSchema,
		etag: z.string().min(1),
		sizeBytes: PositiveIntegerSchema,
	}).strict()),
}).strict();

export const GameUploadSessionListResponseSchema = z.object({
	items: z.array(GameUploadStatusSchema),
}).strict();

export const GameUploadPartUrlsResponseSchema = z.object({
	generation: PositiveIntegerSchema,
	expiresAt: IsoDateTimeSchema,
	parts: z.array(z.object({
		partNumber: PositiveIntegerSchema,
		url: UrlSchema,
		requiredHeaders: z.record(z.string(), z.string()),
	}).strict()),
}).strict();

const GameUploadCompletedBaseSchema = z.object({
	status: z.literal('COMPLETED'),
	sessionId: OpaqueSessionIdSchema,
	generation: PositiveIntegerSchema,
	sizeBytes: PositiveIntegerSchema,
});

export const GameUploadCompleteResponseSchema = z.union([
	GameUploadCompletedBaseSchema.extend({
		uploadKind: z.literal('GAME'),
		assetId: PositiveIntegerSchema,
	}).strict(),
	GameUploadCompletedBaseSchema.extend({
		uploadKind: z.literal('WEBGL'),
		webglUrl: UrlSchema,
	}).strict(),
]);

export const GameUploadVerifyingResponseSchema = z.object({
	status: z.literal('VERIFYING'),
	sessionId: OpaqueSessionIdSchema,
	generation: PositiveIntegerSchema,
	sizeBytes: PositiveIntegerSchema,
}).strict();

export const GameUploadCompletionResponseSchema = z.union([
	GameUploadCompleteResponseSchema,
	GameUploadVerifyingResponseSchema,
]);
