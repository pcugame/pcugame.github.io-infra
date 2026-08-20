import type { FastifyInstance, FastifySchema } from 'fastify';
import { z } from 'zod';
import {
	AdminExhibitionItemSchema,
	AdminExhibitionListResponseSchema,
	AdminProjectDetailSchema,
	AdminProjectListResponseSchema,
	ApiErrorResponseSchema,
	BannedIpListResponseSchema,
	BulkDeleteResponseSchema,
	BulkStatusResponseSchema,
	CreateExhibitionResponseSchema,
	CreatedMemberResponseSchema,
	ExportResultSchema,
	ExportStatusResponseSchema,
	GameUploadChunkResponseSchema,
	GameUploadCompleteResponseSchema,
	GameUploadSessionListResponseSchema,
	GameUploadSessionSchema,
	GameUploadStatusSchema,
	GoogleAuthResponseSchema,
	ImportExecuteResultSchema,
	ImportPreviewResultSchema,
	LogoutResponseSchema,
	MeResponseSchema,
	ProjectAssetUploadResponseSchema,
	PublicExhibitionProjectsResponseSchema,
	PublicProjectDetailResponseSchema,
	PublicYearListResponseSchema,
	PublicYearProjectsResponseSchema,
	SetProjectPosterResponseSchema,
	SiteSettingsDataSchema,
	SubmitProjectResponseSchema,
	apiSuccessSchema,
} from '@pcu/contracts';
import {
	AddMemberBody,
	AdminProjectListQuery,
	BulkDeleteBody,
	BulkStatusBody,
	CreateExhibitionBody,
	DevAuthLoginBody,
	DevAuthLoginErrorBody,
	GameUploadCreateSessionBody,
	GameUploadChunkIdentityQuery,
	GoogleLoginBody,
	SetPosterBody,
	SwapMembersBody,
	UpdateExhibitionBody,
	UpdateMemberBody,
	UpdateProjectBody,
} from './validation.js';

type RouteMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
export type RouteBodyBoundary = 'none' | 'json' | 'multipart' | 'octet-stream' | 'cors-plugin';
export type RouteResponseBoundary =
	| 'json'
	| 'no-content'
	| 'redirect'
	| 'stream'
	| 'errors-only'
	| 'cors-plugin';

export interface RouteRuntimeContract {
	method: RouteMethod;
	url: string;
	family: string;
	bodyBoundary: RouteBodyBoundary;
	responseBoundary: RouteResponseBoundary;
	params: z.ZodType;
	querystring: z.ZodType;
	/**
	 * Multipart is intentionally absent: @fastify/multipart plus the feature
	 * collector own the streaming payload. Octet-stream has an actual stream
	 * schema because its scoped content-type parser assigns request.body.
	 */
	body?: z.ZodType;
	headers?: z.ZodType;
	response: Record<string | number, z.ZodType>;
}

const EmptyObjectSchema = z.object({}).strict();
// Fastify normalizes an absent payload to null for these methods. Accept that
// transport sentinel while rejecting any material JSON value.
const NoBodySchema = z.null().optional();
const NoContentSchema = z.undefined();
const RedirectBodySchema = z.never();
const StreamBodySchema = z.never();
const CheckSchema = z.enum(['ok', 'fail']);

const PositiveIntegerParamSchema = z.string()
	.regex(/^[1-9]\d*$/)
	.refine((value) => Number.isSafeInteger(Number(value)), 'Integer is outside the safe range');
const NonNegativeIntegerParamSchema = z.string()
	.regex(/^(0|[1-9]\d*)$/)
	.refine((value) => Number.isSafeInteger(Number(value)), 'Integer is outside the safe range');
const YearParamSchema = z.string()
	.regex(/^\d{4}$/)
	.refine((value) => {
		const year = Number(value);
		return year >= 1000 && year <= 9999;
	}, 'Year is outside the supported range');
const SessionIdParamSchema = z.string().min(1).max(200).refine(
	(value) => !value.includes('\0'),
	'Session ID contains a NUL byte',
);
const StorageKeyParamSchema = z.string().min(1).max(1024).refine(
	(value) => !value.includes('\0'),
	'Storage key contains a NUL byte',
);
const SlugOrIdParamSchema = z.string().min(1).max(200).refine(
	(value) => !value.includes('\0'),
	'Project identifier contains a NUL byte',
);
const WebglPathParamSchema = z.string().min(1).max(2048).refine(
	(value) => !value.includes('\0'),
	'WebGL path contains a NUL byte',
);

const IdParamsSchema = z.object({ id: PositiveIntegerParamSchema }).strict();
const ProjectIdParamsSchema = z.object({ projectId: PositiveIntegerParamSchema }).strict();
const AssetIdParamsSchema = z.object({ assetId: PositiveIntegerParamSchema }).strict();
const SessionParamsSchema = z.object({ sessionId: SessionIdParamSchema }).strict();
const MemberParamsSchema = z.object({
	id: PositiveIntegerParamSchema,
	memberId: PositiveIntegerParamSchema,
}).strict();
const ChunkParamsSchema = z.object({
	sessionId: SessionIdParamSchema,
	index: NonNegativeIntegerParamSchema,
}).strict();
const WebglWildcardParamsSchema = z.object({
	projectId: PositiveIntegerParamSchema,
	'*': WebglPathParamSchema,
}).strict();

const PublicProjectQuerySchema = z.object({
	year: YearParamSchema.optional(),
}).strict();
const WebglHeadersSchema = z.object({
	range: z.string().optional(),
	'if-none-match': z.string().optional(),
	'if-modified-since': z.string().optional(),
	'if-range': z.string().optional(),
});
const IdempotencyHeadersSchema = z.object({
	'idempotency-key': z.string().min(1).max(200),
}).passthrough();
const OctetStreamSchema = z.custom<NodeJS.ReadableStream>((value) => (
	typeof value === 'object'
	&& value !== null
	&& 'pipe' in value
	&& typeof value.pipe === 'function'
));

const ExportBodySchema = z.union([
	z.object({
		year: z.union([
			z.number().int().min(2000).max(9999),
			z.string().regex(/^(?:2\d{3}|[3-9]\d{3})$/).transform(Number),
		]).optional(),
		dryRun: z.boolean().optional(),
	}).strict(),
	// Fastify uses null as the transport sentinel for an absent POST body.
	z.null(),
]).optional().transform((value) => value ?? {});

const SettingsBodySchema = z.object({
	maxGameFileMb: z.union([
		z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		PositiveIntegerParamSchema.transform(Number),
	]).optional(),
	maxChunkSizeMb: z.union([
		z.number().int().min(5).max(Number.MAX_SAFE_INTEGER),
		PositiveIntegerParamSchema.transform(Number),
	]).refine((value) => value >= 5, 'Chunk size must be at least 5 MiB').optional(),
}).strict().refine(
	(value) => value.maxGameFileMb !== undefined || value.maxChunkSizeMb !== undefined,
	'At least one setting is required',
);

function jsonResponse(data: z.ZodType, status = 200): Record<string | number, z.ZodType> {
	return {
		[status]: apiSuccessSchema(data),
		default: ApiErrorResponseSchema,
	};
}

const NoContentResponse = {
	204: NoContentSchema,
	default: ApiErrorResponseSchema,
};
const RedirectResponse = {
	302: RedirectBodySchema,
	default: ApiErrorResponseSchema,
};
const WebglStreamResponse = {
	200: StreamBodySchema,
	206: StreamBodySchema,
	304: NoContentSchema,
	416: NoContentSchema,
	default: ApiErrorResponseSchema,
};
const WebglHeadResponse = {
	200: NoContentSchema,
	304: NoContentSchema,
	default: ApiErrorResponseSchema,
};
const PublicImageResponse = {
	200: StreamBodySchema,
	304: NoContentSchema,
	default: ApiErrorResponseSchema,
};
const WebglPreflightResponse = {
	204: NoContentSchema,
	default: ApiErrorResponseSchema,
};
const ErrorsOnlyResponse = {
	default: ApiErrorResponseSchema,
};

function healthResponse(
	checks: z.ZodType,
): Record<string | number, z.ZodType> {
	const base = {
		state: z.enum(['starting', 'ready', 'draining', 'shutting_down']),
		timestamp: z.string().datetime({ offset: true }),
	};
	return {
		200: z.object({
			ok: z.literal(true),
			...base,
			checks,
		}).strict(),
		503: z.object({
			ok: z.literal(false),
			...base,
			checks: checks.optional(),
		}).strict(),
		default: ApiErrorResponseSchema,
	};
}

function contract(input: RouteRuntimeContract): RouteRuntimeContract {
	return input;
}

/**
 * Machine-readable union of every explicit route buildApp can register.
 * Most HEAD routes remain Fastify-generated from their GET contracts; public
 * images and WebGL assets declare explicit HEAD routes so streams are never
 * opened to answer metadata-only requests.
 */
export const ROUTE_RUNTIME_CONTRACTS: readonly RouteRuntimeContract[] = [
	contract({
		method: 'OPTIONS',
		url: '*',
		family: 'cors',
		bodyBoundary: 'cors-plugin',
		responseBoundary: 'cors-plugin',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: {
			204: NoContentSchema,
			400: z.string(),
			default: ApiErrorResponseSchema,
		},
	}),
	contract({
		method: 'GET',
		url: '/api/health',
		family: 'health',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: healthResponse(z.object({ db: CheckSchema }).strict()),
	}),
	contract({
		method: 'GET',
		url: '/api/health/deep',
		family: 'health',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: healthResponse(z.object({ db: CheckSchema, s3: CheckSchema }).strict()),
	}),
	contract({
		method: 'POST',
		url: '/api/auth/google',
		family: 'auth',
		bodyBoundary: 'json',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: GoogleLoginBody,
		response: jsonResponse(GoogleAuthResponseSchema),
	}),
	contract({
		method: 'POST',
		url: '/api/auth/logout',
		family: 'auth',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: jsonResponse(LogoutResponseSchema),
	}),
	contract({
		method: 'GET',
		url: '/api/me',
		family: 'auth',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: jsonResponse(MeResponseSchema),
	}),
	contract({
		method: 'POST',
		url: '/api/dev/auth/login',
		family: 'dev-auth',
		bodyBoundary: 'json',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: DevAuthLoginBody,
		response: jsonResponse(GoogleAuthResponseSchema),
	}),
	contract({
		method: 'POST',
		url: '/api/dev/auth/login-error',
		family: 'dev-auth',
		bodyBoundary: 'json',
		responseBoundary: 'errors-only',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: DevAuthLoginErrorBody,
		response: ErrorsOnlyResponse,
	}),
	...[
		'/api/public/webgl/:projectId',
		'/api/public/webgl/:projectId/',
	].map((url) => contract({
		method: 'OPTIONS' as const,
		url,
		family: 'public-webgl',
		bodyBoundary: 'none' as const,
		responseBoundary: 'no-content' as const,
		params: ProjectIdParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: WebglPreflightResponse,
	})),
	contract({
		method: 'OPTIONS',
		url: '/api/public/webgl/:projectId/*',
		family: 'public-webgl',
		bodyBoundary: 'none',
		responseBoundary: 'no-content',
		params: WebglWildcardParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: WebglPreflightResponse,
	}),
	...[
		'/api/public/webgl/:projectId',
		'/api/public/webgl/:projectId/',
	].map((url) => contract({
		method: 'GET' as const,
		url,
		family: 'public-webgl',
		bodyBoundary: 'none' as const,
		responseBoundary: 'stream' as const,
		params: ProjectIdParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		headers: WebglHeadersSchema,
		response: WebglStreamResponse,
	})),
	contract({
		method: 'GET',
		url: '/api/public/webgl/:projectId/*',
		family: 'public-webgl',
		bodyBoundary: 'none',
		responseBoundary: 'stream',
		params: WebglWildcardParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		headers: WebglHeadersSchema,
		response: WebglStreamResponse,
	}),
	...[
		'/api/public/webgl/:projectId',
		'/api/public/webgl/:projectId/',
	].map((url) => contract({
		method: 'HEAD' as const,
		url,
		family: 'public-webgl',
		bodyBoundary: 'none' as const,
		responseBoundary: 'no-content' as const,
		params: ProjectIdParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		headers: WebglHeadersSchema,
		response: WebglHeadResponse,
	})),
	contract({
		method: 'HEAD',
		url: '/api/public/webgl/:projectId/*',
		family: 'public-webgl',
		bodyBoundary: 'none',
		responseBoundary: 'no-content',
		params: WebglWildcardParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		headers: WebglHeadersSchema,
		response: WebglHeadResponse,
	}),
	contract({
		method: 'GET',
		url: '/api/public/years',
		family: 'public',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: jsonResponse(PublicYearListResponseSchema),
	}),
	contract({
		method: 'GET',
		url: '/api/public/images/:storageKey',
		family: 'public',
		bodyBoundary: 'none',
		responseBoundary: 'stream',
		params: z.object({ storageKey: StorageKeyParamSchema }).strict(),
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		headers: z.object({
			'if-none-match': z.string().optional(),
			'if-modified-since': z.string().optional(),
		}).passthrough(),
		response: PublicImageResponse,
	}),
	contract({
		method: 'HEAD',
		url: '/api/public/images/:storageKey',
		family: 'public',
		bodyBoundary: 'none',
		responseBoundary: 'stream',
		params: z.object({ storageKey: StorageKeyParamSchema }).strict(),
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		headers: z.object({
			'if-none-match': z.string().optional(),
			'if-modified-since': z.string().optional(),
		}).passthrough(),
		response: PublicImageResponse,
	}),
	contract({
		method: 'GET',
		url: '/api/public/years/:year/projects',
		family: 'public',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: z.object({ year: YearParamSchema }).strict(),
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: jsonResponse(PublicYearProjectsResponseSchema),
	}),
	contract({
		method: 'GET',
		url: '/api/public/exhibitions/:id/projects',
		family: 'public',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: jsonResponse(PublicExhibitionProjectsResponseSchema),
	}),
	contract({
		method: 'GET',
		url: '/api/public/projects/:idOrSlug',
		family: 'public',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: z.object({ idOrSlug: SlugOrIdParamSchema }).strict(),
		querystring: PublicProjectQuerySchema,
		body: NoBodySchema,
		response: jsonResponse(PublicProjectDetailResponseSchema),
	}),
	contract({
		method: 'GET',
		url: '/api/assets/protected/:storageKey',
		family: 'assets',
		bodyBoundary: 'none',
		responseBoundary: 'redirect',
		params: z.object({ storageKey: StorageKeyParamSchema }).strict(),
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: RedirectResponse,
	}),
	contract({
		method: 'DELETE',
		url: '/api/admin/assets/:assetId',
		family: 'assets',
		bodyBoundary: 'none',
		responseBoundary: 'no-content',
		params: AssetIdParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: NoContentResponse,
	}),
	contract({
		method: 'POST',
		url: '/api/me/projects/submit',
		family: 'me-project',
		bodyBoundary: 'multipart',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		headers: IdempotencyHeadersSchema,
		response: jsonResponse(SubmitProjectResponseSchema, 201),
	}),
	contract({
		method: 'GET',
		url: '/api/admin/exhibitions',
		family: 'admin-exhibitions',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: jsonResponse(AdminExhibitionListResponseSchema),
	}),
	contract({
		method: 'POST',
		url: '/api/admin/exhibitions',
		family: 'admin-exhibitions',
		bodyBoundary: 'json',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: CreateExhibitionBody,
		response: jsonResponse(CreateExhibitionResponseSchema, 201),
	}),
	contract({
		method: 'DELETE',
		url: '/api/admin/exhibitions/:id',
		family: 'admin-exhibitions',
		bodyBoundary: 'none',
		responseBoundary: 'no-content',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: NoContentResponse,
	}),
	contract({
		method: 'PATCH',
		url: '/api/admin/exhibitions/:id',
		family: 'admin-exhibitions',
		bodyBoundary: 'json',
		responseBoundary: 'json',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: UpdateExhibitionBody,
		response: jsonResponse(AdminExhibitionItemSchema),
	}),
	contract({
		method: 'POST',
		url: '/api/admin/exhibitions/:id/poster',
		family: 'admin-exhibitions',
		bodyBoundary: 'multipart',
		responseBoundary: 'json',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		response: jsonResponse(AdminExhibitionItemSchema),
	}),
	contract({
		method: 'DELETE',
		url: '/api/admin/exhibitions/:id/poster',
		family: 'admin-exhibitions',
		bodyBoundary: 'none',
		responseBoundary: 'no-content',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: NoContentResponse,
	}),
	contract({
		method: 'GET',
		url: '/api/admin/projects',
		family: 'admin-projects',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: AdminProjectListQuery,
		body: NoBodySchema,
		response: jsonResponse(AdminProjectListResponseSchema),
	}),
	contract({
		method: 'GET',
		url: '/api/admin/projects/:id',
		family: 'admin-projects',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: jsonResponse(AdminProjectDetailSchema),
	}),
	contract({
		method: 'PATCH',
		url: '/api/admin/projects/:id',
		family: 'admin-projects',
		bodyBoundary: 'json',
		responseBoundary: 'json',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: UpdateProjectBody,
		response: jsonResponse(AdminProjectDetailSchema),
	}),
	contract({
		method: 'DELETE',
		url: '/api/admin/projects/:id',
		family: 'admin-projects',
		bodyBoundary: 'none',
		responseBoundary: 'no-content',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: NoContentResponse,
	}),
	contract({
		method: 'PATCH',
		url: '/api/admin/projects/bulk/status',
		family: 'admin-projects',
		bodyBoundary: 'json',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: BulkStatusBody,
		response: jsonResponse(BulkStatusResponseSchema),
	}),
	contract({
		method: 'POST',
		url: '/api/admin/projects/bulk/delete',
		family: 'admin-projects',
		bodyBoundary: 'json',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: BulkDeleteBody,
		response: jsonResponse(BulkDeleteResponseSchema),
	}),
	contract({
		method: 'POST',
		url: '/api/admin/projects/submit',
		family: 'admin-projects',
		bodyBoundary: 'multipart',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		headers: IdempotencyHeadersSchema,
		response: jsonResponse(SubmitProjectResponseSchema, 201),
	}),
	contract({
		method: 'POST',
		url: '/api/admin/projects/:id/assets',
		family: 'admin-projects',
		bodyBoundary: 'multipart',
		responseBoundary: 'json',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		headers: IdempotencyHeadersSchema,
		response: jsonResponse(ProjectAssetUploadResponseSchema, 201),
	}),
	contract({
		method: 'PATCH',
		url: '/api/admin/projects/:id/poster',
		family: 'admin-projects',
		bodyBoundary: 'json',
		responseBoundary: 'json',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: SetPosterBody,
		response: jsonResponse(SetProjectPosterResponseSchema),
	}),
	contract({
		method: 'DELETE',
		url: '/api/admin/projects/:id/webgl',
		family: 'admin-projects',
		bodyBoundary: 'none',
		responseBoundary: 'no-content',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: NoContentResponse,
	}),
	contract({
		method: 'POST',
		url: '/api/admin/projects/:id/members',
		family: 'admin-members',
		bodyBoundary: 'json',
		responseBoundary: 'json',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: AddMemberBody,
		response: jsonResponse(CreatedMemberResponseSchema, 201),
	}),
	contract({
		method: 'PATCH',
		url: '/api/admin/projects/:id/members/:memberId',
		family: 'admin-members',
		bodyBoundary: 'json',
		responseBoundary: 'no-content',
		params: MemberParamsSchema,
		querystring: EmptyObjectSchema,
		body: UpdateMemberBody,
		response: NoContentResponse,
	}),
	contract({
		method: 'DELETE',
		url: '/api/admin/projects/:id/members/:memberId',
		family: 'admin-members',
		bodyBoundary: 'none',
		responseBoundary: 'no-content',
		params: MemberParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: NoContentResponse,
	}),
	contract({
		method: 'PATCH',
		url: '/api/admin/projects/:id/members/swap',
		family: 'admin-members',
		bodyBoundary: 'json',
		responseBoundary: 'no-content',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: SwapMembersBody,
		response: NoContentResponse,
	}),
	contract({
		method: 'POST',
		url: '/api/admin/projects/:id/game-upload-sessions',
		family: 'game-upload',
		bodyBoundary: 'json',
		responseBoundary: 'json',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: GameUploadCreateSessionBody,
		response: jsonResponse(GameUploadSessionSchema, 201),
	}),
	contract({
		method: 'PUT',
		url: '/api/admin/game-upload-sessions/:sessionId/chunks/:index',
		family: 'game-upload',
		bodyBoundary: 'octet-stream',
		responseBoundary: 'json',
		params: ChunkParamsSchema,
		querystring: GameUploadChunkIdentityQuery,
		body: OctetStreamSchema,
		response: jsonResponse(GameUploadChunkResponseSchema),
	}),
	contract({
		method: 'GET',
		url: '/api/admin/game-upload-sessions/:sessionId',
		family: 'game-upload',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: SessionParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: jsonResponse(GameUploadStatusSchema),
	}),
	contract({
		method: 'POST',
		url: '/api/admin/game-upload-sessions/:sessionId/complete',
		family: 'game-upload',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: SessionParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: jsonResponse(GameUploadCompleteResponseSchema),
	}),
	contract({
		method: 'DELETE',
		url: '/api/admin/game-upload-sessions/:sessionId',
		family: 'game-upload',
		bodyBoundary: 'none',
		responseBoundary: 'no-content',
		params: SessionParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: NoContentResponse,
	}),
	contract({
		method: 'GET',
		url: '/api/admin/projects/:id/game-upload-sessions',
		family: 'game-upload',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: jsonResponse(GameUploadSessionListResponseSchema),
	}),
	contract({
		method: 'GET',
		url: '/api/admin/banned-ips',
		family: 'admin-banned-ips',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: jsonResponse(BannedIpListResponseSchema),
	}),
	contract({
		method: 'DELETE',
		url: '/api/admin/banned-ips/:id',
		family: 'admin-banned-ips',
		bodyBoundary: 'none',
		responseBoundary: 'no-content',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: NoContentResponse,
	}),
	contract({
		method: 'GET',
		url: '/api/admin/settings',
		family: 'admin-settings',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: jsonResponse(SiteSettingsDataSchema),
	}),
	contract({
		method: 'PATCH',
		url: '/api/admin/settings',
		family: 'admin-settings',
		bodyBoundary: 'json',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: SettingsBodySchema,
		response: jsonResponse(SiteSettingsDataSchema),
	}),
	contract({
		method: 'POST',
		url: '/api/admin/import/preview',
		family: 'admin-import',
		bodyBoundary: 'multipart',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		response: jsonResponse(ImportPreviewResultSchema),
	}),
	contract({
		method: 'POST',
		url: '/api/admin/import/execute',
		family: 'admin-import',
		bodyBoundary: 'multipart',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		response: jsonResponse(ImportExecuteResultSchema),
	}),
	contract({
		method: 'POST',
		url: '/api/admin/export',
		family: 'admin-export',
		bodyBoundary: 'json',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: ExportBodySchema,
		response: jsonResponse(ExportResultSchema),
	}),
	contract({
		method: 'GET',
		url: '/api/admin/export/status',
		family: 'admin-export',
		bodyBoundary: 'none',
		responseBoundary: 'json',
		params: EmptyObjectSchema,
		querystring: EmptyObjectSchema,
		body: NoBodySchema,
		response: jsonResponse(ExportStatusResponseSchema),
	}),
] as const;

/** Return the exact active inventory for the current app configuration. */
export function routeRuntimeContractsFor(
	options: { includeDevAuth: boolean },
): readonly RouteRuntimeContract[] {
	return options.includeDevAuth
		? ROUTE_RUNTIME_CONTRACTS
		: ROUTE_RUNTIME_CONTRACTS.filter((route) => route.family !== 'dev-auth');
}

export function findRouteRuntimeContract(
	method: string,
	url: string,
): RouteRuntimeContract | undefined {
	return ROUTE_RUNTIME_CONTRACTS.find(
		(item) => item.method === method && item.url === url,
	) ?? (method === 'HEAD' ? ROUTE_RUNTIME_CONTRACTS.find(
		(item) => item.method === 'GET' && item.url === url,
	) : undefined);
}

/**
 * Attach endpoint-specific validation/serialization contracts at the HTTP
 * composition boundary. Every application/plugin route must be inventoried;
 * an explicit broad schema on an unknown route must not bypass this guard.
 */
export function registerRouteSchemas(app: FastifyInstance): void {
	app.addHook('onRoute', (route) => {
		const methods = Array.isArray(route.method) ? route.method : [route.method];
		const runtimeContracts = methods.map((method) => ({
			method,
			contract: findRouteRuntimeContract(method, route.url),
		}));
		const missing = runtimeContracts.find(({ contract: item }) => item === undefined);
		if (missing) {
			throw new Error(`Route ${missing.method} ${route.url} has no runtime contract`);
		}
		const method = methods[0] ?? 'GET';
		const runtimeContract = runtimeContracts[0]!.contract!;
		if (runtimeContracts.some(({ contract: item }) => item !== runtimeContract)) {
			throw new Error(
				`Route methods ${methods.join(',')} ${route.url} have different runtime contracts; register them separately`,
			);
		}
		const schema: FastifySchema = { ...(route.schema ?? {}) };

		schema.params = runtimeContract.params;
		schema.querystring = runtimeContract.querystring;
		const methodSupportsBody = method !== 'GET' && method !== 'HEAD';
		if (
			runtimeContract.body !== undefined
			&& (
				runtimeContract.bodyBoundary === 'json'
				|| runtimeContract.bodyBoundary === 'octet-stream'
				|| (
					runtimeContract.bodyBoundary === 'none'
					&& methodSupportsBody
				)
			)
		) {
			schema.body = runtimeContract.body;
		} else {
			delete schema.body;
		}
		if (runtimeContract.headers !== undefined) {
			schema.headers = runtimeContract.headers;
		}
		schema.response = runtimeContract.response;
		route.schema = schema;
	});
}
