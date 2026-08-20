import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type {
	GameUploadChunkResponse,
	GameUploadCompletionResponse,
	GameUploadCompleteRequest,
	GameUploadPartUrlsRequest,
	GameUploadPartUrlsResponse,
	GameUploadSession,
	GameUploadSessionListResponse,
	GameUploadStatus,
} from '@pcu/contracts';
import { sendOk, sendCreated } from '../../../shared/http.js';
import {
	GameUploadCreateSessionBody,
	GameUploadChunkIdentityQuery,
	parseBody,
	parseIntParam,
	parseNonNegativeIntParam,
} from '../../../shared/validation.js';
import { requireLogin } from '../../../plugins/auth.js';
import { badRequest, unsupportedMediaType } from '../../../shared/errors.js';
import type { createGameUploadService } from './service.js';
import { GameUploadCompleteBody, GameUploadPartUrlsBody } from './validation.js';

type GameUploadService = ReturnType<typeof createGameUploadService>;

export interface GameUploadControllerDependencies {
	service: GameUploadService;
	access: {
		loadProjectWithAccess(
			actor: NonNullable<FastifyRequest['currentUser']>,
			projectId: number,
		): Promise<{ exhibitionId: number }>;
	};
	chunkUploadBodyLimitBytes: number;
}

/** Register chunked game-upload routes */
export function createGameUploadController(
	deps: GameUploadControllerDependencies,
): FastifyPluginAsync {
	return async function gameUploadController(app): Promise<void> {
	// Register octet-stream parser for this plugin scope only
	app.addContentTypeParser(
		'application/octet-stream',
		function (_request: FastifyRequest, payload: NodeJS.ReadableStream, done: (err: Error | null, body?: unknown) => void) {
			done(null, payload);
		},
	);

	/** POST /projects/:id/game-upload-sessions — create upload session */
	app.post<{ Params: { id: string } }>(
		'/projects/:id/game-upload-sessions',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const projectId = parseIntParam(request.params.id);
			const project = await deps.access.loadProjectWithAccess(
				request.currentUser!,
				projectId,
			);
			const user = request.currentUser!;
			const body = parseBody(GameUploadCreateSessionBody, request.body);
			const result = await deps.service.createSession(
				projectId,
				project.exhibitionId,
				{ id: user.id, role: user.role },
				body,
			);
			sendCreated<GameUploadSession>(reply, result);
		},
	);

	/** PUT /game-upload-sessions/:sessionId/chunks/:index — upload one chunk */
	app.put<{ Params: { sessionId: string; index: string }; Querystring: { sourceIdentityAlgorithm?: string; sourceIdentity?: string } }>(
		'/game-upload-sessions/:sessionId/chunks/:index',
		{
			preParsing: async (request, reply, payload) => {
				// Preserve the route's validation-before-auth contract while gating
				// legacy relay authority before Fastify exposes the payload to a handler.
				parseNonNegativeIntParam(request.params.index, 'Chunk index');
				const mediaType = request.headers['content-type']
					?.split(';', 1)[0]
					?.trim()
					.toLowerCase();
				if (mediaType !== 'application/octet-stream') {
					if (mediaType !== 'application/json') {
						throw unsupportedMediaType('Content-Type must be application/octet-stream');
					}
					throw badRequest('Content-Type must be application/octet-stream');
				}
				parseBody(GameUploadChunkIdentityQuery, request.query);
				await requireLogin(request, reply);
				const user = request.currentUser!;
				await deps.service.authorizeLegacyChunkUpload(
					request.params.sessionId,
					{ id: user.id, role: user.role },
				);
				return payload;
			},
			preHandler: requireLogin,
			bodyLimit: deps.chunkUploadBodyLimitBytes,
			handlerTimeout: 45 * 60 * 1000,
		},
		async (request, reply) => {
			const user = request.currentUser!;
			const result = await deps.service.uploadChunk(
				request.params.sessionId,
				parseNonNegativeIntParam(request.params.index, 'Chunk index'),
				request.body as NodeJS.ReadableStream,
				{ id: user.id, role: user.role },
				parseBody(GameUploadChunkIdentityQuery, request.query),
			);
			sendOk<GameUploadChunkResponse>(reply, result);
		},
	);

	/** Issue short-lived UploadPart capabilities; no object bytes enter Fastify. */
	app.post<{ Params: { sessionId: string }; Body: GameUploadPartUrlsRequest }>(
		'/game-upload-sessions/:sessionId/part-urls',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const user = request.currentUser!;
			const result = await deps.service.signPartUrls(
				request.params.sessionId,
				{ id: user.id, role: user.role },
				parseBody(GameUploadPartUrlsBody, request.body),
			);
			sendOk<GameUploadPartUrlsResponse>(reply, result);
		},
	);

	/** GET /game-upload-sessions/:sessionId — get session status */
	app.get<{ Params: { sessionId: string } }>(
		'/game-upload-sessions/:sessionId',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const user = request.currentUser!;
			const result = await deps.service.getSessionStatus(
				request.params.sessionId,
				{ id: user.id, role: user.role },
			);
			sendOk<GameUploadStatus>(reply, result);
		},
	);

	/** POST /game-upload-sessions/:sessionId/complete — finalize chunked upload */
	app.post<{ Params: { sessionId: string }; Body: GameUploadCompleteRequest }>(
		'/game-upload-sessions/:sessionId/complete',
		{ preHandler: requireLogin, handlerTimeout: 45 * 60 * 1000 },
		async (request, reply) => {
			const user = request.currentUser!;
			const result = await deps.service.completeSession(
				request.params.sessionId,
				{ id: user.id, role: user.role },
				request.body === undefined
					? undefined
					: parseBody(GameUploadCompleteBody, request.body),
			);
			sendOk<GameUploadCompletionResponse>(
				reply,
				result,
				result.status === 'VERIFYING' ? 202 : 200,
			);
		},
	);

	/** DELETE /game-upload-sessions/:sessionId — cancel upload session */
	app.delete<{ Params: { sessionId: string } }>(
		'/game-upload-sessions/:sessionId',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const user = request.currentUser!;
			await deps.service.cancelSession(
				request.params.sessionId,
				{ id: user.id, role: user.role },
			);
			reply.status(204).send();
		},
	);

	/** GET /projects/:id/game-upload-sessions — list active sessions */
	app.get<{ Params: { id: string } }>(
		'/projects/:id/game-upload-sessions',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const projectId = parseIntParam(request.params.id);
			const user = request.currentUser!;
			const items = await deps.service.listSessions(
				projectId,
				{ id: user.id, role: user.role },
			);
			sendOk<GameUploadSessionListResponse>(reply, { items });
		},
	);
	};
}
