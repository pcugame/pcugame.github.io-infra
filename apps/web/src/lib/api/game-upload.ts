/** Direct Garage multipart client for GAME, WEBGL, VIDEO, IMAGE, and POSTER. */

import { env } from '../env';
import { ApiError } from './client';
import type {
	DirectGameUploadCompletionResponse,
	DirectGameUploadCompleteRequest,
	DirectGameUploadCreateSessionRequest,
	DirectGameUploadPartUrlsRequest,
	DirectGameUploadPartUrlsResponse,
	DirectAssetUploadStatus,
	DirectAssetUploadKind,
	DirectAssetUploadOwner,
} from '../../contracts';
import { DIRECT_UPLOAD_BROWSER_PART_BATCH_SIZE } from '../../contracts';
import { createFileSourceIdentity } from '../file-identity';

export interface DirectAssetUploadProgress {
	uploadedChunks: number;
	totalChunks: number;
	uploadedBytes: number;
	totalBytes: number;
	percent: number;
}
const CONTROL_RETRY_ATTEMPTS = 4;
const UPLOAD_PART_RETRY_ATTEMPTS = 4;

function retryAfterMs(value: string | null, fallbackMs: number): number {
	if (!value) return fallbackMs;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds * 1_000));
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.max(1, timestamp - Date.now()) : fallbackMs;
}

function wait(delayMs: number, signal?: AbortSignal | null): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
	return new Promise((resolve, reject) => {
		const finish = () => {
			signal?.removeEventListener('abort', abort);
			resolve();
		};
		const abort = () => {
			window.clearTimeout(timer);
			reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
		};
		const timer = window.setTimeout(finish, delayMs);
		signal?.addEventListener('abort', abort, { once: true });
	});
}

function isTransientControlError(error: unknown): boolean {
	return !(error instanceof ApiError) || error.status === 429 || error.status >= 500;
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
	if (import.meta.env.VITE_MOCK === 'true') {
		const { handleMockRequest } = await import('./mock/handler');
		return handleMockRequest<T>(path, {
			method: init.method ?? 'GET',
			body: init.body,
		});
	}

	const url = `${env.API_BASE_URL}${path}`;
	for (let attempt = 0; ; attempt += 1) {
		const res = await fetch(url, { ...init, credentials: 'include' });
		if (res.ok) {
			if (res.status === 204) return undefined as T;
			const json = await res.json() as Record<string, unknown>;
			if (json.ok && json.data) return json.data as T;
			return json as T;
		}

		let body: unknown;
		try { body = await res.json(); } catch { body = null; }
		if (res.status !== 429 || attempt >= CONTROL_RETRY_ATTEMPTS) {
			throw new ApiError(res.status, res.statusText, body);
		}
		await wait(
			retryAfterMs(res.headers.get('retry-after'), Math.min(30_000, 1_000 * (2 ** attempt))),
			init.signal,
		);
	}
}

/**
 * Canonical data-plane client. The API only exchanges JSON controls;
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

export async function getDirectAssetUploadStatus(sessionId: string): Promise<DirectAssetUploadStatus> {
	return apiRequest<DirectAssetUploadStatus>(`/api/admin/direct-asset-upload-sessions/${sessionId}`);
}

export async function cancelDirectAssetUploadSession(sessionId: string): Promise<void> {
	await apiRequest<void>(`/api/admin/direct-asset-upload-sessions/${sessionId}`, { method: 'DELETE' });
}

/** Poll JSON control state only; Garage never passes archive bytes through the API. */
export async function waitForDirectAssetReady(
	sessionId: string,
	options: { intervalMs?: number; maxIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<DirectAssetUploadStatus> {
	const intervalMs = options.intervalMs ?? 1_500;
	const maxIntervalMs = options.maxIntervalMs ?? 15_000;
	const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
	let transientFailures = 0;
	for (;;) {
		if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
		let status: DirectAssetUploadStatus;
		try {
			status = await apiRequest<DirectAssetUploadStatus>(
				`/api/admin/direct-asset-upload-sessions/${sessionId}`,
				{ signal: options.signal },
			);
			transientFailures = 0;
		} catch (error) {
			if (options.signal?.aborted || !isTransientControlError(error)) throw error;
			transientFailures += 1;
			await wait(Math.min(maxIntervalMs, intervalMs * (2 ** Math.min(transientFailures, 4))), options.signal);
			continue;
		}
		if (status.state === 'READY') return status;
		if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(status.state)) {
			throw new Error(`Direct upload ${status.state.toLowerCase()}`);
		}
		if (deadline !== undefined && Date.now() >= deadline) {
			throw new Error('Direct upload verification is taking longer than the requested wait period');
		}
		await wait(intervalMs, options.signal);
	}
}

/**
 * Garage UploadPart is deliberately outside the API control plane. Mock mode
 * uses an in-memory presigned-capability simulator so local UI exercises the
 * same session/part/complete flow without falling back to an API byte relay.
 */
class DirectUploadPartError extends Error {
	readonly status: number;
	readonly retryAfterMilliseconds: number | undefined;

	constructor(
		status: number,
		retryAfterMilliseconds: number | undefined,
		options?: { cause?: unknown },
	) {
		super(`Direct UploadPart failed (${status || 'network'})`, options);
		this.name = 'DirectUploadPartError';
		this.status = status;
		this.retryAfterMilliseconds = retryAfterMilliseconds;
	}
}

async function putDirectUploadPart(
	capability: { url: string; requiredHeaders: Record<string, string> },
	body: Blob,
): Promise<string> {
	if (import.meta.env.VITE_MOCK === 'true') {
		const { handleMockRequest } = await import('./mock/handler');
		const result = await handleMockRequest<{ etag?: string }>(capability.url, {
			method: 'PUT', body,
		});
		if (!result.etag) throw new Error('Mock UploadPart response omitted ETag');
		return result.etag;
	}
	let response: Response;
	try {
		response = await fetch(capability.url, {
			method: 'PUT', headers: capability.requiredHeaders, body,
		});
	} catch (error) {
		throw new DirectUploadPartError(0, undefined, { cause: error });
	}
	if (!response.ok) {
		throw new DirectUploadPartError(
			response.status,
			response.status === 429
				? retryAfterMs(response.headers.get('retry-after'), 1_000)
				: undefined,
		);
	}
	const etag = response.headers.get('etag');
	if (!etag) throw new Error('Direct UploadPart response omitted ETag');
	return etag;
}

type PreparedPart = { partNumber: number; body: Blob; checksumSha256: string };
type PartCapability = DirectGameUploadPartUrlsResponse['parts'][number];

async function requestPartCapabilities(
	session: DirectAssetUploadSession,
	parts: readonly PreparedPart[],
): Promise<Map<number, PartCapability>> {
	const signed = await apiRequest<DirectGameUploadPartUrlsResponse>(
		`/api/admin/direct-asset-upload-sessions/${session.sessionId}/part-urls`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				generation: session.generation,
				parts: parts.map(({ partNumber, checksumSha256 }) => ({ partNumber, checksumSha256 })),
			} satisfies DirectGameUploadPartUrlsRequest),
		},
	);
	if (signed.generation !== session.generation || signed.parts.length !== parts.length) {
		throw new Error('Direct upload capability response did not match the session generation');
	}
	const requested = new Set(parts.map((part) => part.partNumber));
	const capabilities = new Map<number, PartCapability>();
	for (const capability of signed.parts) {
		if (!requested.has(capability.partNumber) || capabilities.has(capability.partNumber)) {
			throw new Error('Direct upload capability response contained an unexpected part');
		}
		capabilities.set(capability.partNumber, capability);
	}
	return capabilities;
}

async function putPartWithBoundedRetry(
	session: DirectAssetUploadSession,
	part: PreparedPart,
	initialCapability: PartCapability,
): Promise<string> {
	let capability = initialCapability;
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await putDirectUploadPart(capability, part.body);
		} catch (error) {
			if (!(error instanceof DirectUploadPartError) || attempt >= UPLOAD_PART_RETRY_ATTEMPTS) throw error;
			if (error.status === 429) {
				await wait(error.retryAfterMilliseconds ?? Math.min(30_000, 1_000 * (2 ** attempt)));
				continue;
			}
			if (error.status !== 0 && error.status !== 401 && error.status !== 403 && error.status < 500) throw error;
			await wait(Math.min(8_000, 500 * (2 ** attempt)));
			const refreshed = await requestPartCapabilities(session, [part]);
			capability = refreshed.get(part.partNumber)!;
		}
	}
}

/**
 * Canonical GAME/WEBGL data-plane client.  `resume` is recovered from an
 * earlier status result; completed Garage parts are not uploaded again.
 */
export async function uploadDirectAssetFile(
	ownerOrProjectId: DirectAssetUploadOwner | number,
	file: File,
	kind: DirectAssetUploadKind,
	onProgress?: (progress: DirectAssetUploadProgress) => void,
	options: {
		resume?: DirectAssetUploadSession;
		onSession?: (session: DirectAssetUploadSession) => void;
		submissionItem?: { id: string; clientToken: string };
	} = {},
): Promise<DirectGameUploadCompletionResponse> {
	const owner: DirectAssetUploadOwner = typeof ownerOrProjectId === 'number'
		? { type: 'PROJECT', id: ownerOrProjectId }
		: ownerOrProjectId;
	if (owner.type === 'EXHIBITION' && kind !== 'POSTER') {
		throw new Error('Only poster uploads may be owned by an exhibition');
	}
	const source = await createFileSourceIdentity(file);
	let session: DirectAssetUploadSession;
	let uploaded = new Map<number, { etag: string; sizeBytes: number }>();
	if (options.resume) {
		const status = await getDirectAssetUploadStatus(options.resume.sessionId);
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
				body: JSON.stringify({
					originalName: file.name,
					totalBytes: file.size,
					declaredMimeType: file.type || undefined,
					...source,
					...(options.submissionItem ? { submissionItem: options.submissionItem } : {}),
				} satisfies DirectGameUploadCreateSessionRequest),
			},
		);
		session = { ...created, kind };
	}
	options.onSession?.(session);
	const parts: DirectGameUploadCompleteRequest['parts'] = [...uploaded.entries()]
		.map(([partNumber, part]) => ({ partNumber, ...part }))
		.sort((a, b) => a.partNumber - b.partNumber);
	let uploadedBytes = parts.reduce((total, part) => total + part.sizeBytes, 0);
	const pendingPartNumbers = Array.from({ length: session.totalParts }, (_, index) => index + 1)
		.filter((partNumber) => !uploaded.has(partNumber));
	for (let offset = 0; offset < pendingPartNumbers.length; offset += DIRECT_UPLOAD_BROWSER_PART_BATCH_SIZE) {
		const batchNumbers = pendingPartNumbers.slice(offset, offset + DIRECT_UPLOAD_BROWSER_PART_BATCH_SIZE);
		const prepared: PreparedPart[] = [];
		for (const partNumber of batchNumbers) {
			const start = (partNumber - 1) * session.partSizeBytes;
			const body = file.slice(start, Math.min(start + session.partSizeBytes, file.size));
			prepared.push({
				partNumber,
				body,
				checksumSha256: checksumBase64(await crypto.subtle.digest('SHA-256', await body.arrayBuffer())),
			});
		}
		const capabilities = await requestPartCapabilities(session, prepared);
		for (const part of prepared) {
			const capability = capabilities.get(part.partNumber);
			if (!capability) throw new Error('Direct upload capability was not issued');
			const etag = await putPartWithBoundedRetry(session, part, capability);
			parts.push({ partNumber: part.partNumber, etag, sizeBytes: part.body.size });
			uploadedBytes += part.body.size;
			onProgress?.({
				uploadedChunks: parts.length,
				totalChunks: session.totalParts,
				uploadedBytes,
				totalBytes: file.size,
				percent: Math.round((parts.length / session.totalParts) * 100),
			});
		}
	}
	parts.sort((a, b) => a.partNumber - b.partNumber);
	return apiRequest<DirectGameUploadCompletionResponse>(`/api/admin/direct-asset-upload-sessions/${session.sessionId}/complete`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ generation: session.generation, parts } satisfies DirectGameUploadCompleteRequest),
	});
}
