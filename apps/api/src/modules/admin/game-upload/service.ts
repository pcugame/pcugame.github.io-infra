/**
 * Resumable chunked game-file upload service.
 *
 * Flow:
 *   1. createSession()   → create session + staging dir
 *   2. uploadChunk()     → stream one chunk to staging
 *   3. getSessionStatus()→ query progress
 *   4. completeSession() → concatenate chunks → GAME asset
 *   5. cancelSession()   → cancel + cleanup staging
 */

import { promises as fsp, createWriteStream, createReadStream } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../../config/env.js';
import { badRequest, forbidden, notFound, AppError } from '../../../shared/errors.js';
import { generateStorageKey, buildStoragePath } from '../../../shared/storage-path.js';
import { getUploadLimits } from '../../../shared/upload-limits.js';
import { detectFileType, isAllowedGameType } from '../../../shared/file-signature.js';
import { getSiteSettings } from '../../../shared/site-settings.js';
import { logger } from '../../../lib/logger.js';
import { assertUploadAllowed } from '../upload-guard.js';
import * as repo from './repository.js';

// ── Helpers ─────────────────────────────────────────────────

function chunkFileName(index: number): string {
	return `chunk-${String(index).padStart(6, '0')}`;
}

/** Remove a staging directory, logging errors */
async function cleanupStagingDir(stagingPath: string): Promise<void> {
	try {
		await fsp.rm(stagingPath, { recursive: true, force: true });
	} catch (err) {
		logger.error({ err, path: stagingPath }, 'Failed to cleanup staging dir');
	}
}

/** Load and validate a session (ownership, expiry) */
async function loadSession(sessionId: string, userId: number, userRole: string) {
	const session = await repo.findSessionById(sessionId);
	if (!session) throw notFound('Upload session not found');

	const isPrivileged = userRole === 'ADMIN' || userRole === 'OPERATOR';
	if (!isPrivileged && session.userId !== userId) {
		throw forbidden('Not your upload session');
	}

	if (session.expiresAt < new Date()) {
		await repo.updateSessionStatus(session.id, 'CANCELLED');
		await cleanupStagingDir(session.stagingPath);
		throw badRequest('Upload session has expired');
	}

	return session;
}

// ── Service methods ─────────────────────────────────────────

/** Create a new chunked upload session for a project */
export async function createSession(
	projectId: number,
	exhibitionId: number,
	user: { id: number; role: string },
	body: { originalName?: string; totalBytes?: number },
) {
	if (!body?.originalName || !body?.totalBytes) {
		throw badRequest('Missing originalName or totalBytes');
	}

	const cfg = env();
	const { originalName, totalBytes } = body;

	// Enforce exhibition upload lock
	const exhibition = await repo.findExhibitionById(exhibitionId);
	assertUploadAllowed(exhibition, exhibition?.year ?? 0, user.role as any);

	// Read dynamic limit from DB
	const settings = await getSiteSettings();
	const maxGameBytes = settings.maxGameFileMb * 1024 * 1024;
	const chunkSizeBytes = settings.maxChunkSizeMb * 1024 * 1024;

	// Apply role-based limit
	const roleLimits = getUploadLimits(user.role as any);
	const effectiveMax = Math.min(maxGameBytes, roleLimits.gameMaxBytes);

	if (totalBytes <= 0) throw badRequest('totalBytes must be positive');
	if (totalBytes > effectiveMax) {
		const maxMB = Math.round(effectiveMax / 1024 / 1024);
		throw badRequest(`File size ${Math.round(totalBytes / 1024 / 1024)}MB exceeds max ${maxMB}MB`);
	}

	// Cancel existing active sessions for this project
	const existing = await repo.findActiveSessions(projectId);
	for (const s of existing) {
		await repo.updateSessionStatus(s.id, 'CANCELLED');
		await cleanupStagingDir(s.stagingPath);
	}

	const totalChunks = Math.ceil(totalBytes / chunkSizeBytes);
	const sessionId = crypto.randomUUID();
	const stagingPath = path.join(cfg.UPLOAD_STAGING_ROOT, sessionId);

	await fsp.mkdir(stagingPath, { recursive: true });

	const expiresAt = new Date(Date.now() + cfg.UPLOAD_SESSION_TTL_MINUTES * 60 * 1000);

	const session = await repo.createSession({
		id: sessionId,
		projectId,
		userId: user.id,
		originalName,
		totalBytes: BigInt(totalBytes),
		chunkSizeBytes,
		totalChunks,
		stagingPath,
		expiresAt,
	});

	return {
		sessionId: session.id,
		chunkSizeBytes,
		totalChunks,
		expiresAt: expiresAt.toISOString(),
	};
}

/** Stream and save one chunk to the staging directory */
export async function uploadChunk(
	sessionId: string,
	chunkIndex: number,
	body: NodeJS.ReadableStream,
	user: { id: number; role: string },
) {
	const session = await loadSession(sessionId, user.id, user.role);

	if (session.status !== 'PENDING') {
		throw badRequest(`Cannot upload chunks: session is ${session.status}`);
	}

	if (isNaN(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
		throw badRequest(`Invalid chunk index: must be 0..${session.totalChunks - 1}`);
	}

	const isLastChunk = chunkIndex === session.totalChunks - 1;
	const expectedSize = isLastChunk
		? Number(session.totalBytes) - chunkIndex * session.chunkSizeBytes
		: session.chunkSizeBytes;

	const chunkPath = path.join(session.stagingPath, chunkFileName(chunkIndex));
	let bytesWritten = 0;
	const ws = createWriteStream(chunkPath);

	try {
		await new Promise<void>((resolve, reject) => {
			body.on('data', (chunk: Buffer) => {
				bytesWritten += chunk.length;
				if (bytesWritten > expectedSize + 4096) {
					ws.destroy();
					reject(new AppError(413, `Chunk ${chunkIndex} exceeds expected size`, 'PAYLOAD_TOO_LARGE'));
					return;
				}
				if (!ws.write(chunk)) {
					body.pause();
					ws.once('drain', () => body.resume());
				}
			});
			body.on('end', () => { ws.end(() => resolve()); });
			body.on('error', reject);
			ws.on('error', reject);
		});
	} catch (err) {
		await fsp.unlink(chunkPath).catch(() => {});
		throw err;
	}

	if (!isLastChunk && bytesWritten !== expectedSize) {
		await fsp.unlink(chunkPath).catch(() => {});
		throw badRequest(`Chunk ${chunkIndex}: expected ${expectedSize} bytes, got ${bytesWritten}`);
	}

	const updated = await repo.appendChunkIndex(session.id, chunkIndex);
	const newChunks = updated[0]?.uploaded_chunks ?? [];

	return {
		index: chunkIndex,
		bytesWritten,
		uploadedCount: newChunks.length,
		totalChunks: session.totalChunks,
	};
}

/** Get current session status and progress */
export async function getSessionStatus(
	sessionId: string,
	user: { id: number; role: string },
) {
	const session = await loadSession(sessionId, user.id, user.role);
	return {
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
	};
}

/** Finalize a chunked upload: concatenate chunks, validate ZIP, create GAME asset */
export async function completeSession(
	sessionId: string,
	user: { id: number; role: string },
) {
	const cfg = env();
	const session = await loadSession(sessionId, user.id, user.role);

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

	// Atomically transition PENDING → COMPLETING
	const transitioned = await repo.transitionToCompleting(session.id);
	if (transitioned.count === 0) {
		throw badRequest('Session is already being completed by another request');
	}

	try {
		// Concatenate chunks directly to permanent storage
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

		// Verify ZIP signature
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

		// Replace existing GAME asset or create new one
		const existingGame = await repo.findReadyGameAsset(session.projectId);

		let oldBackupPath: string | null = null;
		if (existingGame) {
			const oldPath = buildStoragePath(cfg.UPLOAD_ROOT_PROTECTED, existingGame.storageKey);
			oldBackupPath = oldPath + '.bak';
			await fsp.rename(oldPath, oldBackupPath).catch(() => { oldBackupPath = null; });

			try {
				await repo.updateAssetFile(existingGame.id, {
					storageKey,
					originalName: session.originalName,
					mimeType: 'application/zip',
					sizeBytes: session.totalBytes,
				});
			} catch (dbErr) {
				if (oldBackupPath) {
					const oldPath2 = buildStoragePath(cfg.UPLOAD_ROOT_PROTECTED, existingGame.storageKey);
					await fsp.rename(oldBackupPath, oldPath2).catch(() => {});
				}
				await fsp.unlink(permanentPath).catch(() => {});
				throw dbErr;
			}
			if (oldBackupPath) await fsp.unlink(oldBackupPath).catch(() => {});
		} else {
			try {
				await repo.createGameAsset({
					projectId: session.projectId,
					storageKey,
					originalName: session.originalName,
					sizeBytes: session.totalBytes,
				});
			} catch (dbErr) {
				await fsp.unlink(permanentPath).catch(() => {});
				throw dbErr;
			}
		}

		await repo.markCompleted(session.id, storageKey);
		await cleanupStagingDir(session.stagingPath);

		return {
			status: 'COMPLETED' as const,
			storageKey,
			sizeBytes: Number(session.totalBytes),
		};
	} catch (err) {
		await repo.revertToPending(session.id).catch(() => {});
		throw err;
	}
}

/** Cancel an upload session and cleanup staging */
export async function cancelSession(
	sessionId: string,
	user: { id: number; role: string },
) {
	const session = await loadSession(sessionId, user.id, user.role);

	if (session.status === 'COMPLETED') {
		throw badRequest('Cannot cancel a completed session');
	}

	await repo.updateSessionStatus(session.id, 'CANCELLED');
	await cleanupStagingDir(session.stagingPath);
}

/** List active upload sessions for a project */
export async function listSessions(
	projectId: number,
	user: { id: number; role: string },
) {
	const isPrivileged = user.role === 'ADMIN' || user.role === 'OPERATOR';
	const sessions = await repo.findActiveSessionsForListing(
		projectId,
		isPrivileged ? {} : { userId: user.id },
	);

	return sessions.map((s) => ({
		sessionId: s.id,
		originalName: s.originalName,
		totalBytes: Number(s.totalBytes),
		totalChunks: s.totalChunks,
		uploadedCount: s.uploadedChunks.length,
		status: s.status,
		expiresAt: s.expiresAt.toISOString(),
	}));
}
