import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sendCreated, sendOk } from '../../shared/http.js';
import { AppError } from '../../shared/errors.js';
import { parseBody, parseIntParam } from '../../shared/validation.js';
import { requireLogin } from '../../plugins/auth.js';
import type { createAssetUploadService } from './service.js';

const SourceIdentityBody = z.object({
	originalName: z.string().min(1).max(255),
	totalBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	sourceIdentityAlgorithm: z.literal('SHA256_BLOCK_MANIFEST_V1'),
	sourceIdentity: z.string().regex(/^[a-f0-9]{64}$/),
	sourceIdentityBlockSizeBytes: z.literal(1_048_576),
	sourceIdentityBlockDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
	declaredMimeType: z.string().max(255).optional(),
}).strict();
const PartUrlsBody = z.object({ generation: z.number().int().positive(), parts: z.array(z.object({ partNumber: z.number().int().positive(), checksumSha256: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) }).strict()).min(1) }).strict();
const CompleteBody = z.object({ generation: z.number().int().positive(), parts: z.array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1), sizeBytes: z.number().int().positive() }).strict()) }).strict();

type Service = ReturnType<typeof createAssetUploadService>;

/**
 * New canonical routes. They parse JSON controls only and have no octet-stream
 * parser; registration must be performed by a dedicated direct-upload graph.
 */
export function createAssetUploadController(deps: { service: Service }): FastifyPluginAsync {
	return async function assetUploadController(app) {
		app.post<{ Params: { id: string } }>('/projects/:id/direct-game-upload-sessions', { preHandler: requireLogin }, async (request, reply) => {
			const result = await deps.service.createGameSession(request.currentUser!, parseIntParam(request.params.id), parseBody(SourceIdentityBody, request.body));
			sendCreated(reply, result);
		});
		app.post<{ Params: { id: string } }>('/projects/:id/direct-webgl-upload-sessions', { preHandler: requireLogin }, async (request, reply) => {
			const result = await deps.service.createWebglSession(request.currentUser!, parseIntParam(request.params.id), parseBody(SourceIdentityBody, request.body));
			sendCreated(reply, result);
		});
		app.post<{ Params: { id: string } }>('/projects/:id/direct-video-upload-sessions', { preHandler: requireLogin }, async (request, reply) => {
			const result = await deps.service.createVideoSession(request.currentUser!, parseIntParam(request.params.id), parseBody(SourceIdentityBody, request.body));
			sendCreated(reply, result);
		});
		app.post<{ Params: { id: string } }>('/projects/:id/direct-document-upload-sessions', { preHandler: requireLogin }, async (request, reply) => {
			sendCreated(reply, await deps.service.createDocumentSession(request.currentUser!, parseIntParam(request.params.id), parseBody(SourceIdentityBody, request.body)));
		});
		app.post<{ Params: { id: string } }>('/projects/:id/direct-attachment-upload-sessions', { preHandler: requireLogin }, async (request, reply) => {
			sendCreated(reply, await deps.service.createAttachmentSession(request.currentUser!, parseIntParam(request.params.id), parseBody(SourceIdentityBody, request.body)));
		});
		app.post<{ Params: { id: string } }>('/projects/:id/direct-image-upload-sessions', { preHandler: requireLogin }, async (request, reply) => {
			const result = await deps.service.createImageSession(request.currentUser!, parseIntParam(request.params.id), parseBody(SourceIdentityBody, request.body));
			sendCreated(reply, result);
		});
		app.post<{ Params: { id: string } }>('/projects/:id/direct-poster-upload-sessions', { preHandler: requireLogin }, async (request, reply) => {
			const result = await deps.service.createProjectPosterSession(request.currentUser!, parseIntParam(request.params.id), parseBody(SourceIdentityBody, request.body));
			sendCreated(reply, result);
		});
		app.post<{ Params: { id: string } }>('/exhibitions/:id/direct-poster-upload-sessions', { preHandler: requireLogin }, async (request, reply) => {
			const result = await deps.service.createExhibitionPosterSession(request.currentUser!, parseIntParam(request.params.id), parseBody(SourceIdentityBody, request.body));
			sendCreated(reply, result);
		});
		app.post<{ Params: { sessionId: string } }>('/direct-asset-upload-sessions/:sessionId/part-urls', { preHandler: requireLogin }, async (request, reply) => {
			sendOk(reply, await deps.service.signParts(request.currentUser!, request.params.sessionId, parseBody(PartUrlsBody, request.body)));
		});
		app.get<{ Params: { sessionId: string } }>('/direct-asset-upload-sessions/:sessionId', { preHandler: requireLogin }, async (request, reply) => {
			sendOk(reply, await deps.service.status(request.currentUser!, request.params.sessionId));
		});
		app.post<{ Params: { sessionId: string } }>('/direct-asset-upload-sessions/:sessionId/complete', { preHandler: requireLogin }, async (request, reply) => {
			sendOk(reply, await deps.service.complete(request.currentUser!, request.params.sessionId, parseBody(CompleteBody, request.body)));
		});
		app.delete<{ Params: { sessionId: string } }>('/direct-asset-upload-sessions/:sessionId', { preHandler: requireLogin }, async (request, reply) => {
			await deps.service.cancel(request.currentUser!, request.params.sessionId);
			reply.status(204).send();
		});
	};
}

/**
 * Tests and offline composition use an injected application persistence port
 * instead of Prisma. Keep the production route surface intact there, but fail
 * closed rather than constructing a fake multipart repository or accepting
 * byte traffic. Real production always receives the controller above.
 */
export function createUnavailableAssetUploadController(): FastifyPluginAsync {
	return async function unavailableAssetUploadController(app) {
		const unavailable = async () => {
			throw new AppError(503, 'Canonical direct upload persistence is unavailable', 'INTERNAL_ERROR');
		};
		app.post('/projects/:id/direct-game-upload-sessions', { preHandler: requireLogin }, unavailable);
		app.post('/projects/:id/direct-webgl-upload-sessions', { preHandler: requireLogin }, unavailable);
		app.post('/projects/:id/direct-video-upload-sessions', { preHandler: requireLogin }, unavailable);
		app.post('/projects/:id/direct-document-upload-sessions', { preHandler: requireLogin }, unavailable);
		app.post('/projects/:id/direct-attachment-upload-sessions', { preHandler: requireLogin }, unavailable);
		app.post('/projects/:id/direct-image-upload-sessions', { preHandler: requireLogin }, unavailable);
		app.post('/projects/:id/direct-poster-upload-sessions', { preHandler: requireLogin }, unavailable);
		app.post('/exhibitions/:id/direct-poster-upload-sessions', { preHandler: requireLogin }, unavailable);
		app.post('/direct-asset-upload-sessions/:sessionId/part-urls', { preHandler: requireLogin }, unavailable);
		app.get('/direct-asset-upload-sessions/:sessionId', { preHandler: requireLogin }, unavailable);
		app.post('/direct-asset-upload-sessions/:sessionId/complete', { preHandler: requireLogin }, unavailable);
		app.delete('/direct-asset-upload-sessions/:sessionId', { preHandler: requireLogin }, unavailable);
	};
}
