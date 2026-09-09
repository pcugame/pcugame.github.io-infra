import type { FastifyInstance, FastifySchema } from 'fastify';
import { z } from 'zod';
import { DIRECT_UPLOAD_PART_CAPABILITY_BATCH_MAX } from '@pcu/contracts';
import {
	CreateProjectChangeSchema,
	UpdateProjectChangeSchema,
	RejectProjectChangeSchema,
	ProjectChangeStateSchema,
	ProjectChangeDetailSchema,
	ProjectChangeListResponseSchema,
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
	ExportStartResponseSchema,
	ExportStatusResponseSchema,
	GoogleAuthResponseSchema,
	ImportExecuteResultSchema,
	ImportPreviewResultSchema,
	LogoutResponseSchema,
	MeResponseSchema,
	PublicExhibitionProjectsResponseSchema,
	PublicProjectDetailResponseSchema,
	PublicYearListResponseSchema,
	PublicYearProjectsResponseSchema,
	ProjectSubmissionStatusResponseSchema,
	ProjectSubmissionAuditResponseSchema,
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
	GoogleLoginBody,
	SetPosterBody,
	SetProjectVideoOrderBody,
	SwapMembersBody,
	UpdateExhibitionBody,
	UpdateMemberBody,
	UpdateProjectBody,
	AssetDownloadQuery,
} from './validation.js';

type RouteMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
export type RouteBodyBoundary = 'none' | 'json' | 'multipart' | 'cors-plugin';
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
	 * Multipart is intentionally absent: metadata submission and import parsing
	 * own scalar fields; binary assets use direct Garage multipart sessions.
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
const CheckSchema = z.enum(['ok', 'fail']);

const PositiveIntegerParamSchema = z.string()
	.regex(/^[1-9]\d*$/)
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
const SlugOrIdParamSchema = z.string().min(1).max(200).refine(
	(value) => !value.includes('\0'),
	'Project identifier contains a NUL byte',
);

const IdParamsSchema = z.object({ id: PositiveIntegerParamSchema }).strict();
const AssetIdParamsSchema = z.object({ assetId: PositiveIntegerParamSchema }).strict();
const SessionParamsSchema = z.object({ sessionId: SessionIdParamSchema }).strict();
const MemberParamsSchema = z.object({
	id: PositiveIntegerParamSchema,
	memberId: PositiveIntegerParamSchema,
}).strict();

const PublicProjectQuerySchema = z.object({
	year: YearParamSchema.optional(),
}).strict();
const IdempotencyHeadersSchema = z.object({
	'idempotency-key': z.string().min(1).max(200),
}).passthrough();
const DirectSourceIdentityBody = z.object({
	originalName: z.string().min(1).max(255), totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	sourceIdentityAlgorithm: z.literal('SHA256_BLOCK_MANIFEST_V1'), sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/),
	sourceIdentityBlockSizeBytes: z.literal(1_048_576), sourceIdentityBlockDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
	declaredMimeType: z.string().max(255).optional(),
	submissionItem: z.object({
		id: z.string().uuid(),
		clientToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
	}).strict().optional(),
}).strict();
const DirectPartUrlsBody = z.object({ generation: z.number().int().positive(), parts: z.array(z.object({ partNumber: z.number().int().positive(), checksumSha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) }).strict()).min(1).max(DIRECT_UPLOAD_PART_CAPABILITY_BATCH_MAX) }).strict();
const DirectCompleteBody = z.object({ generation: z.number().int().positive(), parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1), sizeBytes: z.number().int().positive() }).strict()) }).strict();
const DirectOwnerSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('PROJECT'), id: z.number().int().positive() }),
	z.object({ type: z.literal('EXHIBITION'), id: z.number().int().positive() }),
]);
const DirectSessionResponseSchema = z.object({ sessionId: z.string(), owner: DirectOwnerSchema, generation: z.number().int().positive(), partSizeBytes: z.number().int().positive(), totalParts: z.number().int().positive(), expiresAt: z.string(), sourceIdentityAlgorithm: z.literal('SHA256_BLOCK_MANIFEST_V1'), sourceIdentity: z.string(), sourceIdentityBlockSizeBytes: z.literal(1_048_576) });
const DirectStatusResponseSchema = z.object({ sessionId: z.string(), projectId: z.number().int().positive().optional(), exhibitionId: z.number().int().positive().optional(), owner: DirectOwnerSchema, kind: z.enum(['GAME', 'WEBGL', 'VIDEO', 'IMAGE', 'POSTER', 'DOCUMENT', 'ATTACHMENT']), state: z.string(), generation: z.number().int().positive(), originalName: z.string(), totalBytes: z.number().int().positive(), partSizeBytes: z.number().int().positive(), totalParts: z.number().int().positive(), expiresAt: z.string(), sourceIdentityAlgorithm: z.literal('SHA256_BLOCK_MANIFEST_V1'), sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/), parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string(), sizeBytes: z.number().int().positive() })) });
const DirectPartUrlsResponseSchema = z.object({ generation: z.number().int().positive(), expiresAt: z.string(), parts: z.array(z.object({ partNumber: z.number().int().positive(), url: z.string().url(), requiredHeaders: z.record(z.string(), z.string()) })) });
const DirectCompletionResponseSchema = z.object({ status: z.enum(['VERIFYING', 'READY']), sessionId: z.string(), generation: z.number().int().positive(), sizeBytes: z.number().int().positive() });

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
	307: RedirectBodySchema,
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
const ChangeIdParamsSchema = z.object({ id: z.string().uuid() }).strict();
const ChangeListQuerySchema = z.object({
	projectId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
	state: ProjectChangeStateSchema.optional(),
	offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
const changeRouteContracts: RouteRuntimeContract[] = [];
for (const audience of ['me', 'admin'] as const) {
	const base = `/api/${audience}/change-requests`;
	changeRouteContracts.push(
		contract({ method: 'GET', url: base, family: 'project-change', bodyBoundary: 'none', responseBoundary: 'json', params: EmptyObjectSchema, querystring: ChangeListQuerySchema, body: NoBodySchema, response: jsonResponse(ProjectChangeListResponseSchema) }),
		contract({ method: 'GET', url: `${base}/:id`, family: 'project-change', bodyBoundary: 'none', responseBoundary: 'json', params: ChangeIdParamsSchema, querystring: EmptyObjectSchema, body: NoBodySchema, response: jsonResponse(ProjectChangeDetailSchema) }),
	);
	for (const action of audience === 'me' ? ['submit', 'cancel'] : ['approve', 'retry']) {
		changeRouteContracts.push(contract({ method: 'POST', url: `${base}/:id/${action}`, family: 'project-change', bodyBoundary: 'none', responseBoundary: 'json', params: ChangeIdParamsSchema, querystring: EmptyObjectSchema, body: NoBodySchema, response: jsonResponse(ProjectChangeDetailSchema) }));
	}
}
changeRouteContracts.push(
	contract({ method: 'POST', url: '/api/me/projects/:id/change-requests', family: 'project-change', bodyBoundary: 'json', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema, body: CreateProjectChangeSchema, response: jsonResponse(ProjectChangeDetailSchema, 201) }),
	contract({ method: 'GET', url: '/api/me/projects/:id/change-requests', family: 'project-change', bodyBoundary: 'none', responseBoundary: 'json', params: IdParamsSchema, querystring: ChangeListQuerySchema, body: NoBodySchema, response: jsonResponse(ProjectChangeListResponseSchema) }),
	contract({ method: 'PATCH', url: '/api/me/change-requests/:id', family: 'project-change', bodyBoundary: 'json', responseBoundary: 'json', params: ChangeIdParamsSchema, querystring: EmptyObjectSchema, body: UpdateProjectChangeSchema, response: jsonResponse(ProjectChangeDetailSchema) }),
	contract({ method: 'POST', url: '/api/admin/change-requests/:id/reject', family: 'project-change', bodyBoundary: 'json', responseBoundary: 'json', params: ChangeIdParamsSchema, querystring: EmptyObjectSchema, body: RejectProjectChangeSchema, response: jsonResponse(ProjectChangeDetailSchema) }),
);

export const ROUTE_RUNTIME_CONTRACTS: readonly RouteRuntimeContract[] = [
	...changeRouteContracts,
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
		method: 'GET', url: '/api/public/upload-config', family: 'public', params: EmptyObjectSchema, querystring: EmptyObjectSchema,
		bodyBoundary: 'none', responseBoundary: 'json',
		response: jsonResponse(z.object({ materialMaxCount: z.number().int(), materialMaxBytes: z.number().int() })),
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
		url: '/api/assets/:assetId/download',
		family: 'assets',
		bodyBoundary: 'none',
		responseBoundary: 'redirect',
		params: AssetIdParamsSchema,
		querystring: AssetDownloadQuery,
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
	contract({ method: 'GET', url: '/api/me/projects/:id/submission', family: 'me-project-submission', bodyBoundary: 'none', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema, body: NoBodySchema, response: jsonResponse(ProjectSubmissionStatusResponseSchema) }),
	contract({ method: 'POST', url: '/api/me/projects/:id/submission/finalize', family: 'me-project-submission', bodyBoundary: 'none', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema, body: NoBodySchema, response: jsonResponse(ProjectSubmissionStatusResponseSchema) }),
	contract({ method: 'DELETE', url: '/api/me/projects/:id/submission', family: 'me-project-submission', bodyBoundary: 'none', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema, body: NoBodySchema, response: jsonResponse(ProjectSubmissionStatusResponseSchema) }),
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
	contract({ method: 'GET', url: '/api/admin/projects/:id/submission', family: 'admin-project-submission', bodyBoundary: 'none', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema, body: NoBodySchema, response: jsonResponse(ProjectSubmissionStatusResponseSchema) }),
	contract({ method: 'GET', url: '/api/admin/project-submissions/audit', family: 'admin-project-submission', bodyBoundary: 'none', responseBoundary: 'json', params: EmptyObjectSchema, querystring: EmptyObjectSchema, body: NoBodySchema, response: jsonResponse(ProjectSubmissionAuditResponseSchema) }),
	contract({ method: 'POST', url: '/api/admin/projects/:id/submission/finalize', family: 'admin-project-submission', bodyBoundary: 'none', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema, body: NoBodySchema, response: jsonResponse(ProjectSubmissionStatusResponseSchema) }),
	contract({ method: 'DELETE', url: '/api/admin/projects/:id/submission', family: 'admin-project-submission', bodyBoundary: 'none', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema, body: NoBodySchema, response: jsonResponse(ProjectSubmissionStatusResponseSchema) }),
	contract({
		method: 'PUT',
		url: '/api/admin/projects/:id/videos/order',
		family: 'admin-projects',
		bodyBoundary: 'json',
		responseBoundary: 'json',
		params: IdParamsSchema,
		querystring: EmptyObjectSchema,
		body: SetProjectVideoOrderBody,
		response: jsonResponse(z.object({ order: z.array(z.number().int().positive()).max(5) }).strict()),
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
		method: 'POST', url: '/api/admin/projects/:id/direct-game-upload-sessions', family: 'direct-asset-upload',
		bodyBoundary: 'json', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema,
		body: DirectSourceIdentityBody, response: jsonResponse(DirectSessionResponseSchema, 201),
	}),
	contract({
		method: 'POST', url: '/api/admin/projects/:id/direct-webgl-upload-sessions', family: 'direct-asset-upload',
		bodyBoundary: 'json', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema,
		body: DirectSourceIdentityBody, response: jsonResponse(DirectSessionResponseSchema, 201),
	}),
	contract({
		method: 'POST', url: '/api/admin/projects/:id/direct-video-upload-sessions', family: 'direct-asset-upload',
		bodyBoundary: 'json', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema,
		body: DirectSourceIdentityBody, response: jsonResponse(DirectSessionResponseSchema, 201),
	}),
	contract({
		method: 'POST', url: '/api/admin/projects/:id/direct-document-upload-sessions', family: 'direct-asset-upload',
		bodyBoundary: 'json', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema,
		body: DirectSourceIdentityBody, response: jsonResponse(DirectSessionResponseSchema, 201),
	}),
	contract({
		method: 'POST', url: '/api/admin/projects/:id/direct-attachment-upload-sessions', family: 'direct-asset-upload',
		bodyBoundary: 'json', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema,
		body: DirectSourceIdentityBody, response: jsonResponse(DirectSessionResponseSchema, 201),
	}),
	contract({
		method: 'POST', url: '/api/admin/projects/:id/direct-image-upload-sessions', family: 'direct-asset-upload',
		bodyBoundary: 'json', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema,
		body: DirectSourceIdentityBody, response: jsonResponse(DirectSessionResponseSchema, 201),
	}),
	contract({
		method: 'POST', url: '/api/admin/projects/:id/direct-poster-upload-sessions', family: 'direct-asset-upload',
		bodyBoundary: 'json', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema,
		body: DirectSourceIdentityBody, response: jsonResponse(DirectSessionResponseSchema, 201),
	}),
	contract({
		method: 'POST', url: '/api/admin/exhibitions/:id/direct-poster-upload-sessions', family: 'direct-asset-upload',
		bodyBoundary: 'json', responseBoundary: 'json', params: IdParamsSchema, querystring: EmptyObjectSchema,
		body: DirectSourceIdentityBody, response: jsonResponse(DirectSessionResponseSchema, 201),
	}),
	contract({
		method: 'POST', url: '/api/admin/direct-asset-upload-sessions/:sessionId/part-urls', family: 'direct-asset-upload',
		bodyBoundary: 'json', responseBoundary: 'json', params: SessionParamsSchema, querystring: EmptyObjectSchema,
		body: DirectPartUrlsBody, response: jsonResponse(DirectPartUrlsResponseSchema),
	}),
	contract({
		method: 'GET', url: '/api/admin/direct-asset-upload-sessions/:sessionId', family: 'direct-asset-upload',
		bodyBoundary: 'none', responseBoundary: 'json', params: SessionParamsSchema, querystring: EmptyObjectSchema,
		body: NoBodySchema, response: jsonResponse(DirectStatusResponseSchema),
	}),
	contract({
		method: 'POST', url: '/api/admin/direct-asset-upload-sessions/:sessionId/complete', family: 'direct-asset-upload',
		bodyBoundary: 'json', responseBoundary: 'json', params: SessionParamsSchema, querystring: EmptyObjectSchema,
		body: DirectCompleteBody, response: jsonResponse(DirectCompletionResponseSchema),
	}),
	contract({
		method: 'DELETE', url: '/api/admin/direct-asset-upload-sessions/:sessionId', family: 'direct-asset-upload',
		bodyBoundary: 'none', responseBoundary: 'no-content', params: SessionParamsSchema, querystring: EmptyObjectSchema,
		body: NoBodySchema, response: NoContentResponse,
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
		response: jsonResponse(ExportStartResponseSchema, 202),
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
