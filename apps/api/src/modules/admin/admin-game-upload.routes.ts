/**
 * Resumable chunked game-file upload API.
 *
 * Flow:
 *   1. POST   /projects/:id/game-upload-sessions   → create session
 *   2. PUT    /game-upload-sessions/:sid/chunks/:i  → upload one chunk (stream)
 *   3. GET    /game-upload-sessions/:sid             → get session status
 *   4. POST   /game-upload-sessions/:sid/complete    → finalize → GAME asset
 *   5. DELETE /game-upload-sessions/:sid              → cancel + cleanup
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { promises as fsp, createWriteStream, createReadStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import path from 'node:path';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { sendOk, sendCreated } from '../../shared/http.js';
import { badRequest, notFound, forbidden } from '../../shared/errors.js';
import { AppError } from '../../shared/errors.js';
import { requireLogin } from '../../plugins/auth.js';
import { loadProjectWithAccess } from './project-access.js';
import { assertUploadAllowed } from './upload-guard.js';
import { generateStorageKey, buildStoragePath } from '../../shared/storage-path.js';
import { logger } from '../../lib/logger.js';
import { getUploadLimits } from '../../shared/upload-limits.js';
import { detectFileType, isAllowedGameType } from '../../shared/file-signature.js';
import { getSiteSettings } from '../../shared/site-settings.js';

// ── Helpers ──────────────────────────────────────────────────

function chunkFileName(index: number): string {
	return `chunk-${String(index).padStart(6, '0')}`;
}

async function cleanupStagingDir(stagingPath: string): Promise<void> {
	try {
		await fsp.rm(stagingPath, { recursive: true, force: true });
	} catch (err) {
		logger.error({ err, path: stagingPath }, 'Failed to cleanup staging dir');
	}
}

async function loadSession(sessionId: string, userId: string, userRole: string) {
	const session = await prisma.gameUploadSession.findUnique({
		where: { id: sessionId },
	});
	if (!session) throw notFound('Upload session not found');

	const isPrivileged = userRole === 'ADMIN' || userRole === 'OPERATOR';
	if (!isPrivileged && session.userId !== userId) {
		throw forbidden('Not your upload session');
	}

	if (session.expiresAt < new Date()) {
		// Auto-cancel expired session
		await prisma.gameUploadSession.update({
			where: { id: session.id },
			data: { status: 'CANCELLED' },
		});
		await cleanupStagingDir(session.stagingPath);
		throw badRequest('Upload session has expired');
	}

	return session;
}

// ── Routes ───────────────────────────────────────────────────

export async function adminGameUploadRoutes(app: FastifyInstance): Promise<void> {
	const cfg = env();
	// Env values are used as fallback / bodyLimit ceiling only.
	// Actual limits are read from DB (SiteSetting) per-request.

	// Register octet-stream parser for this plugin scope only
	app.addContentTypeParser(
		'application/octet-stream',
		function (_request: FastifyRequest, payload: NodeJS.ReadableStream, done: (err: Error | null, body?: unknown) => void) {
			done(null, payload);
		},
	);

	// ── 1. Create upload session ─────────────────────────────

	app.post<{ Params: { id: string } }>(
		'/projects/:id/game-upload-sessions',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const project = await loadProjectWithAccess(request, request.params.id, { requireDraft: true });

			// Enforce year upload lock (same policy as normal submit)
			const year = await prisma.year.findUnique({ where: { id: project.yearId } });
			assertUploadAllowed(year, year?.year ?? 0, request.currentUser!.role);

			const body = request.body as { originalName?: string; totalBytes?: number };
			if (!body?.originalName || !body?.totalBytes) {
				throw badRequest('Missing originalName or totalBytes');
			}

			const { originalName, totalBytes } = body;

			// Read dynamic limit from DB (admin-configurable, no restart needed)
			const settings = await getSiteSettings();
			const maxGameBytes = settings.maxGameFileMb * 1024 * 1024;
			const chunkSizeBytes = settings.maxChunkSizeMb * 1024 * 1024;

			// Apply role-based game size limit (not just global max)
			const roleLimits = getUploadLimits(request.currentUser!.role);
			const effectiveMax = Math.min(maxGameBytes, roleLimits.gameMaxBytes);

			if (totalBytes <= 0) throw badRequest('totalBytes must be positive');
			if (totalBytes > effectiveMax) {
				const maxMB = Math.round(effectiveMax / 1024 / 1024);
				throw badRequest(`File size ${Math.round(totalBytes / 1024 / 1024)}MB exceeds max ${maxMB}MB`);
			}

			// Cancel any existing PENDING session for this project
			const existing = await prisma.gameUploadSession.findMany({
				where: {
					projectId: request.params.id,
					status: { in: ['PENDING', 'COMPLETING'] },
				},
			});
			for (const s of existing) {
				await prisma.gameUploadSession.update({
					where: { id: s.id },
					data: { status: 'CANCELLED' },
				});
				await cleanupStagingDir(s.stagingPath);
			}

			const totalChunks = Math.ceil(totalBytes / chunkSizeBytes);
			const sessionId = require('node:crypto').randomUUID();
			const stagingPath = path.join(cfg.UPLOAD_STAGING_ROOT, sessionId);

			await fsp.mkdir(stagingPath, { recursive: true });

			const expiresAt = new Date(Date.now() + cfg.UPLOAD_SESSION_TTL_MINUTES * 60 * 1000);

			const session = await prisma.gameUploadSession.create({
				data: {
					id: sessionId,
					projectId: request.params.id,
					userId: request.currentUser!.id,
					originalName,
					totalBytes: BigInt(totalBytes),
					chunkSizeBytes,
					totalChunks,
					stagingPath,
					expiresAt,
				},
			});

			sendCreated(reply, {
				sessionId: session.id,
				chunkSizeBytes,
				totalChunks,
				expiresAt: expiresAt.toISOString(),
			});
		},
	);

	// ── 2. Upload a chunk ────────────────────────────────────

	app.put<{ Params: { sessionId: string; index: string } }>(
		'/game-upload-sessions/:sessionId/chunks/:index',
		{
			preHandler: requireLogin,
			// Fixed ceiling — actual per-chunk validation uses session.chunkSizeBytes
			bodyLimit: 100 * 1024 * 1024, // 100 MB ceiling for any chunk size setting
		},
		async (request, reply) => {
			const user = request.currentUser!;
			const session = await loadSession(request.params.sessionId, user.id, user.role);

			if (session.status !== 'PENDING') {
				throw badRequest(`Cannot upload chunks: session is ${session.status}`);
			}

			const index = parseInt(request.params.index, 10);
			if (isNaN(index) || index < 0 || index >= session.totalChunks) {
				throw badRequest(`Invalid chunk index: must be 0..${session.totalChunks - 1}`);
			}

			// Expected chunk size: last chunk may be smaller
			const isLastChunk = index === session.totalChunks - 1;
			const expectedSize = isLastChunk
				? Number(session.totalBytes) - index * session.chunkSizeBytes
				: session.chunkSizeBytes;

			const chunkPath = path.join(session.stagingPath, chunkFileName(index));

			// Stream request body directly to disk — no memory buffering
			const body = request.body as NodeJS.ReadableStream;
			let bytesWritten = 0;

			const ws = createWriteStream(chunkPath);

			try {
				await new Promise<void>((resolve, reject) => {
					body.on('data', (chunk: Buffer) => {
						bytesWritten += chunk.length;
						if (bytesWritten > expectedSize + 4096) {
							ws.destroy();
							reject(new AppError(413, `Chunk ${index} exceeds expected size`, 'PAYLOAD_TOO_LARGE'));
							return;
						}
						if (!ws.write(chunk)) {
							body.pause();
							ws.once('drain', () => body.resume());
						}
					});
					body.on('end', () => {
						ws.end(() => resolve());
					});
					body.on('error', reject);
					ws.on('error', reject);
				});
			} catch (err) {
				await fsp.unlink(chunkPath).catch(() => {});
				throw err;
			}

			// Verify size (allow ±1 byte rounding tolerance on last chunk)
			if (!isLastChunk && bytesWritten !== expectedSize) {
				await fsp.unlink(chunkPath).catch(() => {});
				throw badRequest(`Chunk ${index}: expected ${expectedSize} bytes, got ${bytesWritten}`);
			}

			// Update uploaded chunks set (idempotent)
			const uploaded = new Set(session.uploadedChunks);
			uploaded.add(index);

			await prisma.gameUploadSession.update({
				where: { id: session.id },
				data: { uploadedChunks: Array.from(uploaded).sort((a: number, b: number) => a - b) },
			});

			sendOk(reply, {
				index,
				bytesWritten,
				uploadedCount: uploaded.size,
				totalChunks: session.totalChunks,
			});
		},
	);

	// ── 3. Get session status ────────────────────────────────

	app.get<{ Params: { sessionId: string } }>(
		'/game-upload-sessions/:sessionId',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const user = request.currentUser!;
			const session = await loadSession(request.params.sessionId, user.id, user.role);

			sendOk(reply, {
				sessionId: session.id,
				projectId: session.projectId,
				originalName: session.originalName,
				totalBytes: Number(session.totalBytes),
				chunkSizeBytes: session.chunkSizeBytes,
				totalChunks: session.totalChunks,
				uploadedChunks: session.uploadedChunks,
				uploadedCount: session.uploadedChunks.length,
				status: session.status,
				expiresAt: session.expiresAt.toISOString(),
			});
		},
	);

	// ── 4. Complete (finalize) ───────────────────────────────

	app.post<{ Params: { sessionId: string } }>(
		'/game-upload-sessions/:sessionId/complete',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const user = request.currentUser!;
			const session = await loadSession(request.params.sessionId, user.id, user.role);

			if (session.status !== 'PENDING') {
				throw badRequest(`Cannot complete: session is ${session.status}`);
			}

			// Verify all chunks present
			const uploaded = new Set(session.uploadedChunks);
			const missing: number[] = [];
			for (let i = 0; i < session.totalChunks; i++) {
				if (!uploaded.has(i)) missing.push(i);
			}
			if (missing.length > 0) {
				throw badRequest(`Missing ${missing.length} chunks: [${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '...' : ''}]`);
			}

			// Mark as COMPLETING to prevent concurrent complete calls
			await prisma.gameUploadSession.update({
				where: { id: session.id },
				data: { status: 'COMPLETING' },
			});

			try {
				// Concatenate chunks directly to permanent storage (no intermediate copy)
				const storageKey = generateStorageKey('zip');
				const permanentPath = buildStoragePath(cfg.UPLOAD_ROOT_PROTECTED, storageKey);
				await fsp.mkdir(path.dirname(permanentPath), { recursive: true });

				const ws = createWriteStream(permanentPath);
				for (let i = 0; i < session.totalChunks; i++) {
					const chunkPath = path.join(session.stagingPath, chunkFileName(i));
					await streamPipeline(createReadStream(chunkPath), ws, { end: false });
				}
				ws.end();
				await new Promise<void>((resolve, reject) => {
					ws.on('finish', resolve);
					ws.on('error', reject);
				});

				// Verify final size
				const stat = await fsp.stat(permanentPath);
				if (stat.size !== Number(session.totalBytes)) {
					await fsp.unlink(permanentPath).catch(() => {});
					throw new AppError(500, `Final file size mismatch: expected ${session.totalBytes}, got ${stat.size}`, 'SIZE_MISMATCH');
				}

				// Verify ZIP signature (read first 8 bytes of concatenated file)
				const fd = await fsp.open(permanentPath, 'r');
				try {
					const header = Buffer.alloc(8);
					await fd.read(header, 0, 8, 0);
					const detected = detectFileType(header);
					if (!detected || !isAllowedGameType(detected)) {
						await fd.close();
						await fsp.unlink(permanentPath).catch(() => {});
						throw badRequest('Uploaded file is not a valid ZIP archive');
					}
				} finally {
					await fd.close().catch(() => {});
				}

				// Replace existing GAME asset if any, else create new one.
				// Safe ordering: rename old file → update DB → delete old file.
				const existingGame = await prisma.asset.findFirst({
					where: { projectId: session.projectId, kind: 'GAME', status: 'READY' },
				});

				let oldBackupPath: string | null = null;
				if (existingGame) {
					const oldPath = buildStoragePath(cfg.UPLOAD_ROOT_PROTECTED, existingGame.storageKey);
					oldBackupPath = oldPath + '.bak';
					// Rename old file to backup (safe — can restore on failure)
					await fsp.rename(oldPath, oldBackupPath).catch(() => {
						oldBackupPath = null; // old file missing — nothing to back up
					});

					try {
						await prisma.asset.update({
							where: { id: existingGame.id },
							data: {
								storageKey,
								originalName: session.originalName,
								mimeType: 'application/zip',
								sizeBytes: session.totalBytes,
							},
						});
					} catch (dbErr) {
						// DB update failed — restore old file from backup
						if (oldBackupPath) {
							const oldPath2 = buildStoragePath(cfg.UPLOAD_ROOT_PROTECTED, existingGame.storageKey);
							await fsp.rename(oldBackupPath, oldPath2).catch(() => {});
						}
						await fsp.unlink(permanentPath).catch(() => {});
						throw dbErr;
					}

					// DB succeeded — safe to remove backup of old file
					if (oldBackupPath) await fsp.unlink(oldBackupPath).catch(() => {});
				} else {
					try {
						await prisma.asset.create({
							data: {
								projectId: session.projectId,
								kind: 'GAME',
								storageKey,
								originalName: session.originalName,
								mimeType: 'application/zip',
								sizeBytes: session.totalBytes,
								isPublic: false,
							},
						});
					} catch (dbErr) {
						// DB create failed — remove orphan permanent file
						await fsp.unlink(permanentPath).catch(() => {});
						throw dbErr;
					}
				}

				// Mark complete and cleanup staging
				await prisma.gameUploadSession.update({
					where: { id: session.id },
					data: { status: 'COMPLETED', storageKey },
				});
				await cleanupStagingDir(session.stagingPath);

				sendOk(reply, {
					status: 'COMPLETED',
					storageKey,
					sizeBytes: Number(session.totalBytes),
				});
			} catch (err) {
				// Revert to PENDING so user can retry
				await prisma.gameUploadSession.update({
					where: { id: session.id },
					data: { status: 'PENDING' },
				}).catch(() => {});
				throw err;
			}
		},
	);

	// ── 5. Cancel ────────────────────────────────────────────

	app.delete<{ Params: { sessionId: string } }>(
		'/game-upload-sessions/:sessionId',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const user = request.currentUser!;
			const session = await loadSession(request.params.sessionId, user.id, user.role);

			if (session.status === 'COMPLETED') {
				throw badRequest('Cannot cancel a completed session');
			}

			await prisma.gameUploadSession.update({
				where: { id: session.id },
				data: { status: 'CANCELLED' },
			});
			await cleanupStagingDir(session.stagingPath);

			reply.status(204).send();
		},
	);

	// ── 6. List active sessions for a project ────────────────

	app.get<{ Params: { id: string } }>(
		'/projects/:id/game-upload-sessions',
		{ preHandler: requireLogin },
		async (request, reply) => {
			const user = request.currentUser!;
			const isPrivileged = user.role === 'ADMIN' || user.role === 'OPERATOR';

			const sessions = await prisma.gameUploadSession.findMany({
				where: {
					projectId: request.params.id,
					status: { in: ['PENDING', 'COMPLETING'] },
					...(isPrivileged ? {} : { userId: user.id }),
				},
				orderBy: { createdAt: 'desc' },
			});

			sendOk(reply, {
				items: sessions.map((s) => ({
					sessionId: s.id,
					originalName: s.originalName,
					totalBytes: Number(s.totalBytes),
					totalChunks: s.totalChunks,
					uploadedCount: s.uploadedChunks.length,
					status: s.status,
					expiresAt: s.expiresAt.toISOString(),
				})),
			});
		},
	);
}
