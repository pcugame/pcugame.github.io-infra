import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendOk, sendCreated } from '../../../shared/http.js';
import { parseIntParam } from '../../../shared/validation.js';
import { requireLogin } from '../../../plugins/auth.js';
import { loadProjectWithAccess } from '../project-access.js';
import * as gameUploadService from './service.js';

/** Register chunked game-upload routes */
export async function gameUploadController(app: FastifyInstance): Promise<void> {
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
			const project = await loadProjectWithAccess(request, projectId, { requireDraft: true });
			const user = request.currentUser!;
			const result = await gameUploadService.createSession(
				projectId,
				project.exhibitionId,
				{ id: user.id, role: user.role },
				request.body as { originalName?: string; totalBytes?: number },
			);
			sendCreated(reply, result);
		},
	);

	/** PUT /game-upload-sessions/:sessionId/chunks/:index — upload one chunk */
	app.put<{ Params: { sessionId: string; index: string } }>(
		'/game-upload-sessions/:sessionId/chunks/:index',
		{
			preHandler: requireLogin,
			bodyLimit: 100 * 1024 * 1024, // 100 MB ceiling
		},
		async (request, reply) => {
			const user = request.currentUser!;
			const result = await gameUploadService.uploadChunk(
				request.params.sessionId,
				parseInt(request.params.index, 10),
				request.body as NodeJS.ReadableStream,
				{ id: user.id, role: user.role },
			);
			sendOk(reply, result);
		},
	);

	/** GET /game-upload-sessions/:sessionId — get session status */
	app.get<{ Params: { sessionId: string } }>(
		'/game-upload-sessions/:sessionId',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const user = request.currentUser!;
			const result = await gameUploadService.getSessionStatus(
				request.params.sessionId,
				{ id: user.id, role: user.role },
			);
			sendOk(reply, result);
		},
	);

	/** POST /game-upload-sessions/:sessionId/complete — finalize chunked upload */
	app.post<{ Params: { sessionId: string } }>(
		'/game-upload-sessions/:sessionId/complete',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const user = request.currentUser!;
			const result = await gameUploadService.completeSession(
				request.params.sessionId,
				{ id: user.id, role: user.role },
			);
			sendOk(reply, result);
		},
	);

	/** DELETE /game-upload-sessions/:sessionId — cancel upload session */
	app.delete<{ Params: { sessionId: string } }>(
		'/game-upload-sessions/:sessionId',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const user = request.currentUser!;
			await gameUploadService.cancelSession(
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
			const items = await gameUploadService.listSessions(
				projectId,
				{ id: user.id, role: user.role },
			);
			sendOk(reply, { items });
		},
	);
}
