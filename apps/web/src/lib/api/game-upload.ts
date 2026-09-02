/**
 * Chunked game-file upload client.
 *
 * Splits a File into chunks and uploads them sequentially with
 * resume/retry support. Progress is tracked per-chunk.
 */

import { env } from '../env';
import { ApiError } from './client';
import { failUpload, finishUpload, startUpload, updateUpload } from '../upload';
import type {
	GameUploadChunkResponse,
	GameUploadCompleteResponse,
	GameUploadCreateSessionRequest,
	GameUploadSession,
	GameUploadSessionListResponse,
	GameUploadStatus,
	DirectGameUploadCompletionResponse,
	DirectGameUploadCompleteRequest,
	DirectGameUploadCreateSessionRequest,
	DirectGameUploadPartUrlsRequest,
	DirectAssetUploadStatus,
	DirectAssetUploadKind,
	DirectAssetUploadOwner,
	UploadKind,
} from '../../contracts';
import { createFileSourceIdentity } from '../file-identity';

// ── Types ────────────────────────────────────────────────────

export type { GameUploadSession, GameUploadStatus };

export interface GameUploadProgress {
	uploadedChunks: number;
	totalChunks: number;
	uploadedBytes: number;
	totalBytes: number;
	percent: number;
}

export interface GameUploadController {
	/** Start or resume the upload. Returns when fully complete. */
	start: () => Promise<GameUploadCompleteResponse>;
	/** Abort the in-progress upload (can still be resumed later). */
	abort: () => void;
}

function throwIfAborted(signal?: AbortSignal | null): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

export interface UploadGameFileOptions {
	title: string;
	onProgress?: (progress: GameUploadProgress) => void;
	startFrom?: number[];
}

// ── Helpers ──────────────────────────────────────────────────

async function apiRequest<T>(
	path: string,
	init: RequestInit = {},
	retrySignal?: AbortSignal,
): Promise<T> {
	const effectiveRetrySignal = retrySignal ?? init.signal;
	throwIfAborted(effectiveRetrySignal);
	if (import.meta.env.VITE_MOCK === 'true') {
		const { handleMockRequest } = await import('./mock/handler');
		const result = await handleMockRequest<T>(path, {
			method: init.method ?? 'GET',
			body: init.body,
		});
		throwIfAborted(effectiveRetrySignal);
		return result;
	}

	const url = `${env.API_BASE_URL}${path}`;
	const res = await fetch(url, { ...init, credentials: 'include' });
	throwIfAborted(effectiveRetrySignal);

	if (!res.ok) {
		let body: unknown;
		try { body = await res.json(); } catch { body = null; }
		throwIfAborted(effectiveRetrySignal);
		throw new ApiError(res.status, res.statusText, body);
	}

	if (res.status === 204) {
		throwIfAborted(effectiveRetrySignal);
		return undefined as T;
	}

	const json = await res.json() as Record<string, unknown>;
	throwIfAborted(effectiveRetrySignal);
	if (json.ok && json.data) return json.data as T;
	return json as T;
}

// ── Public API ───────────────────────────────────────────────

/** Create a new upload session for a game file. */
export async function createGameUploadSession(
	projectId: number,
	file: File,
	uploadKind: UploadKind = 'GAME',
): Promise<GameUploadSession> {
	return apiRequest<GameUploadSession>(
		`/api/admin/projects/${projectId}/game-upload-sessions`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				originalName: file.name,
				totalBytes: file.size,
				uploadKind,
			} satisfies GameUploadCreateSessionRequest),
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
	uploadKind?: UploadKind,
): Promise<GameUploadSessionListResponse> {
	const response = await apiRequest<GameUploadSessionListResponse>(
		`/api/admin/projects/${projectId}/game-upload-sessions`,
	);
	return uploadKind
		? { items: response.items.filter((item) => (item.uploadKind ?? 'GAME') === uploadKind) }
		: response;
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
 * @param options     Upload title, progress callback, and resume chunk indices
 * @returns controller with start() and abort()
 */
export function uploadGameFile(
	file: File,
	session: GameUploadSession,
	options: UploadGameFileOptions,
): GameUploadController {
	let aborted = false;
	let taskId: string | null = null;

	const uploadedSet = new Set(options.startFrom ?? []);

	function ensureTask() {
		if (taskId) return taskId;
		taskId = startUpload({
			title: options.title,
			phase: 'uploading',
			totalBytes: file.size,
			loadedBytes: 0,
			percent: 0,
			processingMessage: '파일 조립 및 검증이 끝날 때까지 이 창을 닫거나 새로고침하지 마세요.',
		});
		return taskId;
	}

	function reportProgress() {
		const uploadTaskId = ensureTask();
		const uploadedBytes = uploadedSet.size * session.chunkSizeBytes;
		const progress = {
			uploadedChunks: uploadedSet.size,
			totalChunks: session.totalChunks,
			uploadedBytes: Math.min(uploadedBytes, file.size),
			totalBytes: file.size,
			percent: Math.round((uploadedSet.size / session.totalChunks) * 100),
		};
		options.onProgress?.(progress);
		updateUpload(uploadTaskId, {
			phase: 'uploading',
			loadedBytes: progress.uploadedBytes,
			totalBytes: progress.totalBytes,
			percent: Math.min(99, progress.percent),
		});
	}

	async function start() {
		const uploadTaskId = ensureTask();
		try {
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
						await apiRequest<GameUploadChunkResponse>(
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

			updateUpload(uploadTaskId, {
				phase: 'processing',
				loadedBytes: file.size,
				totalBytes: file.size,
				percent: 99,
			});

			// All chunks uploaded — finalize
			const result = await apiRequest<GameUploadCompleteResponse>(
				`/api/admin/game-upload-sessions/${session.sessionId}/complete`,
				{ method: 'POST' },
			);

			finishUpload(uploadTaskId);
			return result;
		} catch (err) {
			if ((err as Error).message === 'Upload aborted') {
				failUpload(uploadTaskId, '업로드가 일시정지되었습니다.');
			} else {
				failUpload(uploadTaskId, err instanceof Error ? err.message : '업로드 중 오류가 발생했습니다.');
			}
			throw err;
		}
	}

	return {
		start,
		abort: () => { aborted = true; },
	};
}

/**
 * Canonical GAME data-plane client. The API only exchanges JSON controls;
 * every File slice is PUT directly to the Garage UploadPart capability.
 */
export type DirectAssetUploadSession = {
	sessionId: string;
	owner: DirectAssetUploadOwner;
	generation: number;
	partSizeBytes: number;
	totalParts: number;
	expiresAt: string;
	sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1';
	sourceIdentity: string;
	kind: DirectAssetUploadKind;
};

function checksumBase64(bytes: ArrayBuffer): string {
	const view = new Uint8Array(bytes);
	let binary = '';
	// Avoid spreading a multi-megabyte typed array into String.fromCharCode.
	for (let offset = 0; offset < view.length; offset += 0x8000) {
		binary += String.fromCharCode(...view.subarray(offset, Math.min(offset + 0x8000, view.length)));
	}
	return btoa(binary);
}

export async function getDirectAssetUploadStatus(
	sessionId: string,
	signal?: AbortSignal,
): Promise<DirectAssetUploadStatus> {
	return apiRequest<DirectAssetUploadStatus>(
		`/api/admin/direct-asset-upload-sessions/${sessionId}`,
		{ signal },
	);
}

export async function cancelDirectAssetUploadSession(sessionId: string): Promise<void> {
	await apiRequest<void>(`/api/admin/direct-asset-upload-sessions/${sessionId}`, { method: 'DELETE' });
}

/** Poll JSON control state only; Garage never passes archive bytes through the API. */
export async function waitForDirectAssetReady(
	sessionId: string,
	options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<DirectAssetUploadStatus> {
	const intervalMs = options.intervalMs ?? 1_500;
	const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
	for (;;) {
		const status = await getDirectAssetUploadStatus(sessionId);
		if (status.state === 'READY') return status;
		if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(status.state)) {
			throw new Error(`Direct upload ${status.state.toLowerCase()}`);
		}
		if (Date.now() >= deadline) throw new Error('Direct upload verification is taking longer than expected');
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

/**
 * Garage UploadPart is deliberately outside the API control plane. Mock mode
 * uses an in-memory presigned-capability simulator so local UI exercises the
 * same session/part/complete flow without falling back to an API byte relay.
 */
async function putDirectUploadPart(
	capability: { url: string; requiredHeaders: Record<string, string> },
	body: Blob,
	signal?: AbortSignal,
): Promise<string> {
	throwIfAborted(signal);
	if (import.meta.env.VITE_MOCK === 'true') {
		const { handleMockRequest } = await import('./mock/handler');
		const result = await handleMockRequest<{ etag?: string }>(capability.url, {
			method: 'PUT', body,
		});
		throwIfAborted(signal);
		if (!result.etag) throw new Error('Mock UploadPart response omitted ETag');
		return result.etag;
	}
	let response: Response;
	try {
		response = await fetch(capability.url, {
			method: 'PUT', headers: capability.requiredHeaders, body, signal,
		});
	} catch (error) {
		throwIfAborted(signal);
		if (isAbortError(error)) throw error;
		throw error;
	}
	throwIfAborted(signal);
	if (!response.ok) throw new Error(`Direct UploadPart failed (${response.status})`);
	const etag = response.headers.get('etag');
	if (!etag) throw new Error('Direct UploadPart response omitted ETag');
	return etag;
}

/**
 * Canonical GAME/WEBGL data-plane client.  `resume` is recovered from an
 * earlier status result; completed Garage parts are not uploaded again.
 */
export async function uploadDirectAssetFile(
	ownerOrProjectId: DirectAssetUploadOwner | number,
	file: File,
	kind: DirectAssetUploadKind,
	onProgress?: (progress: GameUploadProgress) => void,
	options: {
		resume?: DirectAssetUploadSession;
		onSession?: (session: DirectAssetUploadSession) => void;
		signal?: AbortSignal;
	} = {},
): Promise<DirectGameUploadCompletionResponse> {
	const owner: DirectAssetUploadOwner = typeof ownerOrProjectId === 'number'
		? { type: 'PROJECT', id: ownerOrProjectId }
		: ownerOrProjectId;
	if (owner.type === 'EXHIBITION' && kind !== 'POSTER') {
		throw new Error('Only poster uploads may be owned by an exhibition');
	}
	throwIfAborted(options.signal);
	const source = await createFileSourceIdentity(file, { signal: options.signal });
	throwIfAborted(options.signal);
	let session: DirectAssetUploadSession;
	let uploaded = new Map<number, { etag: string; sizeBytes: number }>();
	if (options.resume) {
		const status = await getDirectAssetUploadStatus(options.resume.sessionId, options.signal);
		throwIfAborted(options.signal);
		if (status.owner.type !== owner.type || status.owner.id !== owner.id || status.kind !== kind || status.generation !== options.resume.generation
			|| status.totalBytes !== file.size || status.originalName !== file.name
			|| status.sourceIdentity !== source.sourceIdentity || status.state !== 'UPLOADING') {
			throw new Error('Selected file does not match an upload session that can be resumed');
		}
		session = {
			sessionId: status.sessionId, generation: status.generation, partSizeBytes: status.partSizeBytes,
			totalParts: status.totalParts, expiresAt: status.expiresAt,
			sourceIdentityAlgorithm: status.sourceIdentityAlgorithm, sourceIdentity: status.sourceIdentity, kind, owner: status.owner,
		};
		uploaded = new Map(status.parts.map((part) => [part.partNumber, { etag: part.etag, sizeBytes: part.sizeBytes }]));
	} else {
		const created = await apiRequest<DirectAssetUploadSession>(
			`/api/admin/${owner.type === 'PROJECT' ? 'projects' : 'exhibitions'}/${owner.id}/direct-${kind.toLowerCase()}-upload-sessions`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ originalName: file.name, totalBytes: file.size, declaredMimeType: file.type || undefined, ...source } satisfies DirectGameUploadCreateSessionRequest),
			},
			options.signal,
		);
		session = { ...created, kind };
	}
	options.onSession?.(session);
	throwIfAborted(options.signal);
	const parts: DirectGameUploadCompleteRequest['parts'] = [];
	for (let partNumber = 1; partNumber <= session.totalParts; partNumber += 1) {
		throwIfAborted(options.signal);
		const start = (partNumber - 1) * session.partSizeBytes;
		const body = file.slice(start, Math.min(start + session.partSizeBytes, file.size));
		const existing = uploaded.get(partNumber);
		if (existing?.sizeBytes === body.size) {
			parts.push({ partNumber, etag: existing.etag, sizeBytes: existing.sizeBytes });
			onProgress?.({ uploadedChunks: parts.length, totalChunks: session.totalParts, uploadedBytes: Math.min(parts.length * session.partSizeBytes, file.size), totalBytes: file.size, percent: Math.round((parts.length / session.totalParts) * 100) });
			throwIfAborted(options.signal);
			continue;
		}
		const bytes = await body.arrayBuffer();
		throwIfAborted(options.signal);
		const checksum = checksumBase64(await crypto.subtle.digest('SHA-256', bytes));
		throwIfAborted(options.signal);
		const signed = await apiRequest<{ parts: Array<{ partNumber: number; url: string; requiredHeaders: Record<string, string> }> }>(
			`/api/admin/direct-asset-upload-sessions/${session.sessionId}/part-urls`,
			{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation: session.generation, parts: [{ partNumber, checksumSha256: checksum }] } satisfies DirectGameUploadPartUrlsRequest) },
			options.signal,
		);
		throwIfAborted(options.signal);
		const capability = signed.parts[0];
		if (!capability) throw new Error('Direct upload capability was not issued');
		const etag = await putDirectUploadPart(capability, body, options.signal);
		parts.push({ partNumber, etag, sizeBytes: body.size });
		onProgress?.({ uploadedChunks: partNumber, totalChunks: session.totalParts, uploadedBytes: Math.min(partNumber * session.partSizeBytes, file.size), totalBytes: file.size, percent: Math.round((partNumber / session.totalParts) * 100) });
		throwIfAborted(options.signal);
	}
	throwIfAborted(options.signal);
	const completion = await apiRequest<DirectGameUploadCompletionResponse>(`/api/admin/direct-asset-upload-sessions/${session.sessionId}/complete`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ generation: session.generation, parts } satisfies DirectGameUploadCompleteRequest),
	}, options.signal);
	throwIfAborted(options.signal);
	return completion;
}

/** Backward-compatible GAME export while callers migrate to the generic name. */
export async function uploadGameFileDirect(projectId: number, file: File, onProgress?: (progress: GameUploadProgress) => void): Promise<DirectGameUploadCompletionResponse> {
	return uploadDirectAssetFile(projectId, file, 'GAME', onProgress);
}

export async function uploadImageFileDirect(owner: DirectAssetUploadOwner, file: File, onProgress?: (progress: GameUploadProgress) => void): Promise<DirectGameUploadCompletionResponse> {
	return uploadDirectAssetFile(owner, file, 'IMAGE', onProgress);
}

export async function uploadPosterFileDirect(owner: DirectAssetUploadOwner, file: File, onProgress?: (progress: GameUploadProgress) => void): Promise<DirectGameUploadCompletionResponse> {
	return uploadDirectAssetFile(owner, file, 'POSTER', onProgress);
}

export async function uploadWebglFileDirect(projectId: number, file: File, onProgress?: (progress: GameUploadProgress) => void): Promise<DirectGameUploadCompletionResponse> {
	return uploadDirectAssetFile(projectId, file, 'WEBGL', onProgress);
}

export async function uploadVideoFileDirect(projectId: number, file: File, onProgress?: (progress: GameUploadProgress) => void): Promise<DirectGameUploadCompletionResponse> {
	return uploadDirectAssetFile(projectId, file, 'VIDEO', onProgress);
}
