/**
 * Game-file upload client.
 *
 * Object bytes move from the browser straight to Garage. The API only creates
 * sessions, issues capabilities, reconciles ListParts, and commits completion.
 */

import { env } from '../env';
import { ApiError } from './client';
import { failUpload, finishUpload, startUpload, updateUpload } from '../upload';
import type { FileIdentity } from '../upload/file-identity';
import type {
	GameUploadCompletionResponse,
	GameUploadCompleteRequest,
	GameUploadCreateSessionRequest,
	GameUploadPartUrlsResponse,
	GameUploadSession,
	GameUploadSessionListResponse,
	GameUploadStatus,
	GameUploadUploadedPart,
	UploadKind,
} from '@pcu/contracts';

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
	start: () => Promise<GameUploadCompletionResponse>;
	/** Abort the in-progress upload (can still be resumed later). */
	abort: () => void;
}

export interface UploadGameFileOptions {
	title: string;
	onProgress?: (progress: GameUploadProgress) => void;
	/** Garage-reconciled parts returned by the status endpoint. */
	resumeParts?: GameUploadUploadedPart[];
	/** Resume polling after storage completion without sending bytes again. */
	resumeFinalizationStatus?: 'COMPLETING' | 'VERIFYING';
}

const DIRECT_CONCURRENCY = 4;
// The API accepts a configurable batch size from 8 through 32. Keep the
// browser-side request at the minimum so every supported deployment setting
// can sign the batch without rejecting an otherwise valid upload.
const SIGN_BATCH_SIZE = 8;
const MAX_PART_ATTEMPTS = 3;
const VERIFY_POLL_INTERVAL_MS = 2_000;
const VERIFY_TIMEOUT_MS = 30 * 60 * 1_000;

function abortError(): Error {
	return new Error('Upload aborted');
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortError();
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
	if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error('파트 checksum 읽기 실패'));
		reader.onload = () => resolve(reader.result as ArrayBuffer);
		reader.readAsArrayBuffer(blob);
	});
}

// ── Helpers ──────────────────────────────────────────────────

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
	if (import.meta.env.VITE_MOCK === 'true') {
		const { handleMockRequest } = await import('./mock/handler');
		return handleMockRequest<T>(path, {
			method: init.method ?? 'GET',
			body: init.body,
		});
	}

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
	identity: FileIdentity,
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
				sourceIdentityAlgorithm: identity.sourceIdentityAlgorithm,
				sourceIdentity: identity.sourceIdentity,
				sourceIdentityBlockSizeBytes: identity.sourceIdentityBlockSizeBytes,
				sourceIdentityBlockDigests: identity.sourceIdentityBlockDigests,
				uploadKind,
			} satisfies GameUploadCreateSessionRequest),
		},
	);
}

/** Get the current status of an upload session. */
export async function getGameUploadStatus(
	sessionId: string,
	signal?: AbortSignal,
): Promise<GameUploadStatus> {
	return apiRequest<GameUploadStatus>(
		`/api/admin/game-upload-sessions/${sessionId}`,
		{ signal },
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
		? { items: response.items.filter((item) => item.uploadKind === uploadKind) }
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
	let taskId: string | null = null;
	const abortController = new AbortController();
	const completedParts = new Map<number, GameUploadUploadedPart>();
	const partChecksumCache = new Map<number, string>();
	for (const part of options.resumeParts ?? []) {
		if (part.partNumber >= 1 && part.partNumber <= session.totalChunks) {
			completedParts.set(part.partNumber, part);
		}
	}

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
		const uploadedBytes = [...completedParts.values()]
			.reduce((total, part) => total + part.sizeBytes, 0);
		const progress = {
			uploadedChunks: completedParts.size,
			totalChunks: session.totalChunks,
			uploadedBytes: Math.min(uploadedBytes, file.size),
			totalBytes: file.size,
			percent: Math.round((completedParts.size / session.totalChunks) * 100),
		};
		options.onProgress?.(progress);
		updateUpload(uploadTaskId, {
			phase: 'uploading',
			loadedBytes: progress.uploadedBytes,
			totalBytes: progress.totalBytes,
			percent: Math.min(99, progress.percent),
		});
	}

	async function signPartUrls(partNumbers: number[]): Promise<GameUploadPartUrlsResponse> {
		throwIfAborted(abortController.signal);
		const generation = session.generation;
		if (!Number.isSafeInteger(generation) || generation < 1) {
			throw new Error('직접 업로드 세션 generation이 없습니다. 새 업로드 세션을 시작하세요.');
		}
		const parts = await Promise.all(partNumbers.map(async (partNumber) => {
			const cached = partChecksumCache.get(partNumber);
			if (cached) return { partNumber, checksumSha256: cached };
			const start = (partNumber - 1) * session.chunkSizeBytes;
			const end = Math.min(start + session.chunkSizeBytes, file.size);
			const body = file.slice(start, end);
			throwIfAborted(abortController.signal);
			const digest = new Uint8Array(await crypto.subtle.digest(
				'SHA-256',
				await readBlobBytes(body),
			));
			throwIfAborted(abortController.signal);
			let binary = '';
			for (const byte of digest) binary += String.fromCharCode(byte);
			const checksumSha256 = btoa(binary);
			partChecksumCache.set(partNumber, checksumSha256);
			return { partNumber, checksumSha256 };
		}));
		const response = await apiRequest<GameUploadPartUrlsResponse>(
			`/api/admin/game-upload-sessions/${session.sessionId}/part-urls`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ generation, parts }),
				signal: abortController.signal,
			},
		);
		if (response.generation !== generation) {
			throw new Error('파트 서명 응답의 session generation이 일치하지 않습니다.');
		}
		const requested = new Set(partNumbers);
		const returned = new Set(response.parts.map((part) => part.partNumber));
		if (response.parts.length !== partNumbers.length
			|| returned.size !== response.parts.length
			|| returned.size !== requested.size
			|| [...requested].some((partNumber) => !returned.has(partNumber))) {
			throw new Error('파트 서명 응답이 요청한 part 목록과 일치하지 않습니다.');
		}
		return response;
	}

	async function putDirectPart(
		partNumber: number,
		initialCapability: GameUploadPartUrlsResponse['parts'][number],
	): Promise<GameUploadUploadedPart> {
		const start = (partNumber - 1) * session.chunkSizeBytes;
		const end = Math.min(start + session.chunkSizeBytes, file.size);
		const body = file.slice(start, end);
		if (import.meta.env.VITE_MOCK === 'true') {
			return { partNumber, etag: `"mock-etag-${partNumber}"`, sizeBytes: body.size };
		}
		let capability = initialCapability;
		let lastError: unknown;

		for (let attempt = 1; attempt <= MAX_PART_ATTEMPTS; attempt++) {
			throwIfAborted(abortController.signal);
			try {
				const response = await fetch(capability.url, {
					method: 'PUT',
					headers: capability.requiredHeaders,
					body,
					signal: abortController.signal,
				});
				if (response.ok) {
					const etag = response.headers.get('etag');
					if (!etag) {
						throw new Error(
							`파트 ${partNumber} 업로드 응답에서 ETag를 읽을 수 없습니다. Garage CORS ExposeHeaders에 ETag가 있는지 확인하세요.`,
						);
					}
					return { partNumber, etag, sizeBytes: body.size };
				}

				lastError = new Error(`파트 ${partNumber} 직접 업로드 실패 (HTTP ${response.status})`);
				if ((response.status === 401 || response.status === 403) && attempt < MAX_PART_ATTEMPTS) {
					const refreshed = await signPartUrls([partNumber]);
					const replacement = refreshed.parts.find((part) => part.partNumber === partNumber);
					if (!replacement) throw new Error(`파트 ${partNumber} 재서명 응답이 올바르지 않습니다.`);
					capability = replacement;
				}
			} catch (error) {
				if (abortController.signal.aborted) throw abortError();
				// Missing ETag is a CORS/configuration error, not a transient PUT error.
				if (error instanceof Error && error.message.includes('ETag')) throw error;
				lastError = error;
			}
			if (attempt < MAX_PART_ATTEMPTS) {
				await abortableDelay(250 * attempt, abortController.signal);
			}
		}

		throw lastError instanceof Error
			? lastError
			: new Error(`파트 ${partNumber} 직접 업로드에 실패했습니다.`);
	}

	async function uploadDirectBatch(partNumbers: number[]): Promise<void> {
		const signed = await signPartUrls(partNumbers);
		const capabilities = new Map(signed.parts.map((part) => [part.partNumber, part]));
		let cursor = 0;
		let firstError: unknown;
		const workers = Array.from(
			{ length: Math.min(DIRECT_CONCURRENCY, partNumbers.length) },
			async () => {
				try {
					while (cursor < partNumbers.length) {
						const partNumber = partNumbers[cursor++];
						if (partNumber === undefined) return;
						const capability = capabilities.get(partNumber);
						if (!capability) throw new Error(`파트 ${partNumber} 서명 응답이 없습니다.`);
						const part = await putDirectPart(partNumber, capability);
						// A sibling may have failed while this PUT response was resolving.
						// Garage will reconcile any such successful part on the next status
						// request; do not mutate local progress after batch cancellation.
						throwIfAborted(abortController.signal);
						completedParts.set(partNumber, part);
						reportProgress();
					}
				} catch (error) {
					if (firstError === undefined) {
						firstError = error;
						abortController.abort();
					}
				}
			},
		);
		// Worker errors are captured above so this waits for every sibling PUT or
		// retry delay to observe the shared abort before start() rejects.
		await Promise.all(workers);
		if (firstError !== undefined) throw firstError;
	}

	async function waitUntilValidationFinishes(
		completion: GameUploadCompletionResponse,
		completeBody: GameUploadCompleteRequest,
	): Promise<GameUploadCompletionResponse> {
		if (completion.status !== 'VERIFYING') return completion;
		const deadline = Date.now() + VERIFY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			throwIfAborted(abortController.signal);
			const status = await getGameUploadStatus(session.sessionId, abortController.signal);
			if (status.status === 'PENDING') {
				const expectedGeneration = session.generation;
				if (!Number.isSafeInteger(expectedGeneration)
					|| status.generation !== expectedGeneration) {
					throw new Error('업로드 복구 중 session generation이 변경되었습니다. 세션 상태를 다시 확인하세요.');
				}
				const recoveredParts = [...(status.parts ?? [])].sort(
					(a, b) => a.partNumber - b.partNumber,
				);
				const completePartNumbers = status.totalChunks === session.totalChunks
					&& recoveredParts.length === status.totalChunks
					&& recoveredParts.every((part, index) => part.partNumber === index + 1);
				if (!completePartNumbers) {
					throw new Error(
						'업로드 완료 복구에 필요한 part가 부족합니다. 같은 파일로 이어올리기를 다시 시도하세요.',
					);
				}
				completedParts.clear();
				for (const part of recoveredParts) {
					completedParts.set(part.partNumber, part);
				}
				completeBody = { generation: expectedGeneration, parts: recoveredParts };
				const recoveredCompletion = await apiRequest<GameUploadCompletionResponse>(
					`/api/admin/game-upload-sessions/${session.sessionId}/complete`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(completeBody),
						signal: abortController.signal,
					},
				);
				if (recoveredCompletion.status === 'COMPLETED') return recoveredCompletion;
				// The storage completion was reclaimed and is VERIFYING again. Poll
				// immediately once; subsequent VERIFYING polls retain the normal delay.
				continue;
			}
			if (status.status === 'COMPLETED') {
				// Completion is idempotent. Re-read the server-owned final result so
				// callers keep receiving the established COMPLETED response contract.
				const finalResult = await apiRequest<GameUploadCompletionResponse>(
					`/api/admin/game-upload-sessions/${session.sessionId}/complete`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(completeBody),
						signal: abortController.signal,
					},
				);
				if (finalResult.status !== 'COMPLETED') {
					throw new Error('완료된 업로드의 최종 결과를 조회하지 못했습니다.');
				}
				return finalResult;
			}
			if (['REJECTED', 'FAILED', 'CANCELLED', 'EXPIRED'].includes(status.status)) {
				throw new Error(`업로드 검증에 실패했습니다. (상태: ${status.status})`);
			}
			await abortableDelay(VERIFY_POLL_INTERVAL_MS, abortController.signal);
		}
		throw new Error('업로드 검증 대기 시간이 초과되었습니다. 세션 상태를 다시 확인하세요.');
	}

	async function startDirect(): Promise<GameUploadCompletionResponse> {
		const generation = session.generation;
		if (!Number.isSafeInteger(generation) || generation < 1) {
			throw new Error('직접 업로드 세션 generation이 없습니다.');
		}
		if (options.resumeFinalizationStatus) {
			const completeBody: GameUploadCompleteRequest = { generation, parts: [] };
			return waitUntilValidationFinishes({
				status: 'VERIFYING',
				sessionId: session.sessionId,
				generation,
				sizeBytes: file.size,
			}, completeBody);
		}
		const remaining = Array.from({ length: session.totalChunks }, (_, index) => index + 1)
			.filter((partNumber) => !completedParts.has(partNumber));
		for (let offset = 0; offset < remaining.length; offset += SIGN_BATCH_SIZE) {
			throwIfAborted(abortController.signal);
			await uploadDirectBatch(remaining.slice(offset, offset + SIGN_BATCH_SIZE));
		}
		const body: GameUploadCompleteRequest = {
			generation,
			parts: [...completedParts.values()].sort((a, b) => a.partNumber - b.partNumber),
		};
		const uploadTaskId = ensureTask();
		updateUpload(uploadTaskId, {
			phase: 'processing',
			loadedBytes: file.size,
			totalBytes: file.size,
			percent: 99,
		});
		const completion = await apiRequest<GameUploadCompletionResponse>(
			`/api/admin/game-upload-sessions/${session.sessionId}/complete`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: abortController.signal,
			},
		);
		return waitUntilValidationFinishes(completion, body);
	}

	async function start() {
		const uploadTaskId = ensureTask();
		try {
			reportProgress();

			const result = await startDirect();

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
		abort: () => { abortController.abort(); },
	};
}
