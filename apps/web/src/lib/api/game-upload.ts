/**
 * Chunked game-file upload client.
 *
 * Splits a File into chunks and uploads them sequentially with
 * resume/retry support. Progress is tracked per-chunk.
 */

import { env } from '../env';
import { ApiError } from './client';

// ── Types ────────────────────────────────────────────────────

export interface GameUploadSession {
	sessionId: string;
	chunkSizeBytes: number;
	totalChunks: number;
	expiresAt: string;
}

export interface GameUploadStatus {
	sessionId: string;
	projectId: number;
	originalName: string;
	totalBytes: number;
	chunkSizeBytes: number;
	totalChunks: number;
	uploadedChunks: number[];
	uploadedCount: number;
	status: string;
	expiresAt: string;
}

export interface GameUploadProgress {
	uploadedChunks: number;
	totalChunks: number;
	uploadedBytes: number;
	totalBytes: number;
	percent: number;
}

export interface GameUploadController {
	/** Start or resume the upload. Returns when fully complete. */
	start: () => Promise<{ status: string; storageKey: string; sizeBytes: number }>;
	/** Abort the in-progress upload (can still be resumed later). */
	abort: () => void;
}

// ── Helpers ──────────────────────────────────────────────────

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
	const url = `${env.API_BASE_URL}${path}`;
	const res = await fetch(url, { ...init, credentials: 'include' });

	if (!res.ok) {
		let body: unknown;
		try { body = await res.json(); } catch { body = null; }
		throw new ApiError(res.status, res.statusText, body);
	}

	if (res.status === 204) return undefined as T;

	const json = await res.json() as Record<string, unknown>;
	if (json.ok && json.data) return json.data as T;
	return json as T;
}

// ── Public API ───────────────────────────────────────────────

/** Create a new upload session for a game file. */
export async function createGameUploadSession(
	projectId: number,
	file: File,
): Promise<GameUploadSession> {
	return apiRequest<GameUploadSession>(
		`/api/admin/projects/${projectId}/game-upload-sessions`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				originalName: file.name,
				totalBytes: file.size,
			}),
		},
	);
}

/** Get the current status of an upload session. */
export async function getGameUploadStatus(
	sessionId: string,
): Promise<GameUploadStatus> {
	return apiRequest<GameUploadStatus>(
		`/api/admin/game-upload-sessions/${sessionId}`,
	);
}

/** List active sessions for a project. */
export async function listGameUploadSessions(
	projectId: number,
): Promise<{ items: GameUploadStatus[] }> {
	return apiRequest<{ items: GameUploadStatus[] }>(
		`/api/admin/projects/${projectId}/game-upload-sessions`,
	);
}

/** Cancel an upload session. */
export async function cancelGameUploadSession(
	sessionId: string,
): Promise<void> {
	await apiRequest<void>(
		`/api/admin/game-upload-sessions/${sessionId}`,
		{ method: 'DELETE' },
	);
}

/**
 * Upload a file in chunks with progress tracking and resume support.
 *
 * @param file        The game ZIP file
 * @param session     The session from createGameUploadSession
 * @param onProgress  Called after each chunk completes
 * @param startFrom   Array of already-uploaded chunk indices (for resume)
 * @returns controller with start() and abort()
 */
export function uploadGameFile(
	file: File,
	session: GameUploadSession,
	onProgress?: (progress: GameUploadProgress) => void,
	startFrom: number[] = [],
): GameUploadController {
	let aborted = false;

	const uploadedSet = new Set(startFrom);

	function reportProgress() {
		if (!onProgress) return;
		const uploadedBytes = uploadedSet.size * session.chunkSizeBytes;
		onProgress({
			uploadedChunks: uploadedSet.size,
			totalChunks: session.totalChunks,
			uploadedBytes: Math.min(uploadedBytes, file.size),
			totalBytes: file.size,
			percent: Math.round((uploadedSet.size / session.totalChunks) * 100),
		});
	}

	async function start() {
		reportProgress();

		for (let i = 0; i < session.totalChunks; i++) {
			if (aborted) throw new Error('Upload aborted');
			if (uploadedSet.has(i)) continue; // already uploaded (resume)

			const start = i * session.chunkSizeBytes;
			const end = Math.min(start + session.chunkSizeBytes, file.size);
			const chunk = file.slice(start, end);

			// Retry up to 3 times per chunk
			let lastErr: unknown;
			for (let attempt = 0; attempt < 3; attempt++) {
				if (aborted) throw new Error('Upload aborted');
				try {
					await apiRequest(
						`/api/admin/game-upload-sessions/${session.sessionId}/chunks/${i}`,
						{
							method: 'PUT',
							headers: { 'Content-Type': 'application/octet-stream' },
							body: chunk,
						},
					);
					lastErr = null;
					break;
				} catch (err) {
					lastErr = err;
					// Wait before retry (exponential backoff)
					if (attempt < 2) {
						await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
					}
				}
			}
			if (lastErr) throw lastErr;

			uploadedSet.add(i);
			reportProgress();
		}

		// All chunks uploaded — finalize
		const result = await apiRequest<{ status: string; storageKey: string; sizeBytes: number }>(
			`/api/admin/game-upload-sessions/${session.sessionId}/complete`,
			{ method: 'POST' },
		);

		return result;
	}

	return {
		start,
		abort: () => { aborted = true; },
	};
}
