import type { FastifyInstance, FastifySchema } from 'fastify';
import { z } from 'zod';
import {
	AddMemberBody,
	AdminProjectListQuery,
	BulkDeleteBody,
	BulkStatusBody,
	CreateExhibitionBody,
	DevAuthLoginBody,
	DevAuthLoginErrorBody,
	GameUploadCreateSessionBody,
	GoogleLoginBody,
	SetPosterBody,
	SwapMembersBody,
	UpdateExhibitionBody,
	UpdateMemberBody,
	UpdateProjectBody,
} from './validation.js';

const ExportBody = z.object({
	year: z.coerce.number().int().min(2000).optional(),
	dryRun: z.boolean().optional(),
});

const SettingsBody = z.object({
	maxGameFileMb: z.coerce.number().int().positive().optional(),
	maxChunkSizeMb: z.coerce.number().int().positive().optional(),
});

function bodySchema(method: string, url: string): z.ZodType | undefined {
	if (method === 'POST' && url.endsWith('/auth/google')) return GoogleLoginBody;
	if (method === 'POST' && url.endsWith('/auth/login')) return DevAuthLoginBody;
	if (method === 'POST' && url.endsWith('/auth/login-error')) return DevAuthLoginErrorBody;
	if (method === 'POST' && url.endsWith('/exhibitions')) return CreateExhibitionBody;
	if (method === 'PATCH' && /\/exhibitions\/:id$/.test(url)) return UpdateExhibitionBody;
	if (method === 'PATCH' && /\/projects\/:id$/.test(url)) return UpdateProjectBody;
	if (method === 'PATCH' && url.endsWith('/projects/bulk/status')) return BulkStatusBody;
	if (method === 'POST' && url.endsWith('/projects/bulk/delete')) return BulkDeleteBody;
	if (method === 'PATCH' && url.endsWith('/poster')) return SetPosterBody;
	if (method === 'POST' && /\/projects\/:id\/members$/.test(url)) return AddMemberBody;
	if (method === 'PATCH' && /\/members\/:memberId$/.test(url)) return UpdateMemberBody;
	if (method === 'PATCH' && url.endsWith('/members/swap')) return SwapMembersBody;
	if (method === 'POST' && url.endsWith('/game-upload-sessions')) return GameUploadCreateSessionBody;
	if (method === 'PATCH' && url.endsWith('/settings')) return SettingsBody;
	if (method === 'POST' && url.endsWith('/export')) return ExportBody;
	return undefined;
}

function paramsSchema(url: string): z.ZodType | undefined {
	const names = [...url.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
	if (url.includes('*')) names.push('*');
	if (names.length === 0) return undefined;
	return z.object(Object.fromEntries(names.map((name) => [name, z.string().min(1)])));
}

function querySchema(url: string): z.ZodType | undefined {
	if (url.endsWith('/projects') && !url.includes('/public/')) return AdminProjectListQuery;
	if (/\/public\/projects\/:idOrSlug$/.test(url) || url.endsWith('/projects/:idOrSlug')) {
		return z.object({ year: z.string().optional() });
	}
	return undefined;
}

/**
 * Attach validation/serialization schemas at the HTTP composition boundary.
 * Multipart and streaming routes receive params/headers/response schemas while
 * JSON commands reuse the same Zod contracts as their application parsers.
 */
export function registerRouteSchemas(app: FastifyInstance): void {
	app.addHook('onRoute', (route) => {
		const method = Array.isArray(route.method) ? route.method[0] ?? 'GET' : route.method;
		const url = route.url;
		const schema: FastifySchema = { ...(route.schema ?? {}) };
		// The Zod compiler intentionally warns when one of these slots is absent.
		// Unknown is the compatibility-preserving schema for routes without a
		// narrower contract (including multipart and stream bodies).
		schema.params ??= paramsSchema(url) ?? z.unknown();
		schema.querystring ??= querySchema(url) ?? z.unknown();
		schema.body ??= bodySchema(method, url) ?? z.unknown();
		if (url.includes('/webgl/')) {
			schema.headers ??= z.object({ range: z.string().optional() }).passthrough();
		}
		// z.unknown validates that serialization succeeds without narrowing a
		// transport contract that is already expressed by @pcu/contracts types.
		schema.response ??= { default: z.unknown() };
		route.schema = schema;
	});
}
