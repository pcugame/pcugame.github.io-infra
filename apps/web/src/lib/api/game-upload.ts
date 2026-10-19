/** Direct Garage multipart client for GAME, WEBGL, VIDEO, IMAGE, and POSTER. */

import { putUploadPart } from './upload-part-transport';
import { env } from '../env';
import { ApiError } from './client';
import type {
	DirectAssetUploadCreation,
	DirectAssetUploadCreationLookup,
	DirectGameUploadCompletionResponse,
	DirectGameUploadCompleteRequest,
	DirectGameUploadCreateSessionRequest,
	DirectGameUploadPartUrlsRequest,
	DirectGameUploadPartUrlsResponse,
	DirectAssetUploadStatus,
	DirectAssetUploadKind,
	DirectAssetUploadOwner,
} from '../../contracts';
import { DirectAssetUploadCreationSchema, DirectAssetUploadCreationLookupSchema, DIRECT_UPLOAD_BROWSER_PART_BATCH_SIZE } from '../../contracts';
import { createFileSourceIdentity } from '../file-identity';

export interface DirectAssetUploadProgress {
	phase?: 'checking' | 'preparing' | 'uploading' | 'transferred' | 'completing' | 'verifying' | 'ready';
	confirmedBytes?: number;
	inFlightBytes?: number;
	uploadedChunks: number;
	totalChunks: number;
	uploadedBytes: number;
	totalBytes: number;
	percent: number;
}
/** A create may have committed even when its response could not be read. */
export class DirectUploadCreateError extends Error {
	readonly uncertain: boolean;
	constructor(uncertain: boolean, cause: unknown) {
		super(uncertain
			? '업로드 생성 결과를 확인할 수 없습니다. 연결이 복구되면 같은 업로드를 다시 확인하거나 취소해 주세요.'
			: '업로드 세션을 생성하지 못했습니다. 다시 시도해 주세요.', { cause });
		this.uncertain = uncertain;
	}
}
export class DirectUploadAllocationPendingError extends DirectUploadCreateError {
	constructor() { super(true, undefined); this.message = '서버에서 업로드를 생성 중입니다. 잠시 후 재시도하거나 취소해 주세요.'; }
}
/** Only the create endpoint may attest that this attempt rejected before allocation. */
export function isDirectUploadPreCreationRejection(cause: unknown): boolean {
	return cause instanceof ApiError && 'rejectedBeforeCreation' in cause && cause.rejectedBeforeCreation === true;
}

export type DirectUploadCreateRequest = DirectGameUploadCreateSessionRequest & { clientUploadId: string };

export async function getDirectAssetUploadCreation(clientUploadId: string): Promise<DirectAssetUploadCreationLookup> {
	return DirectAssetUploadCreationLookupSchema.parse(await apiRequest(`/api/admin/direct-asset-upload-creations/${encodeURIComponent(clientUploadId)}`, { signal: AbortSignal.timeout(15_000) }));
}
export async function createDirectAssetUploadSession(owner: DirectAssetUploadOwner, kind: DirectAssetUploadKind, request: DirectUploadCreateRequest, retrySignal?: AbortSignal): Promise<DirectAssetUploadCreation> {
	try {
		const deadline = AbortSignal.timeout(30_000);
		const result = DirectAssetUploadCreationSchema.parse(await apiRequest(
			`/api/admin/${owner.type === 'PROJECT' ? 'projects' : 'exhibitions'}/${owner.id}/direct-${kind.toLowerCase()}-upload-sessions`,
			{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: deadline },
			retrySignal ? AbortSignal.any([retrySignal, deadline]) : deadline,
		));
		if (result.clientUploadId !== request.clientUploadId || result.owner.type !== owner.type || result.owner.id !== owner.id
			|| result.kind !== kind || result.sourceIdentity !== request.sourceIdentity) throw new Error('업로드 생성 응답이 요청과 일치하지 않습니다.');
		return result;
	} catch (cause) {
		if (cause instanceof ApiError) {
			const code = (cause.body as { error?: { code?: string } } | null)?.error?.code;
			// In the canonical create route these validation/auth errors precede
			// createAllocating. Generic CONFLICT can follow allocation; neither it,
			// IDEMPOTENCY_CONFLICT nor an unknown 4xx proves absence of a session.
			// This attests only to this attempt, never to an earlier lost response.
			const rejectedBeforeCreation = (cause.status === 400 && ['ERROR', 'VALIDATION_ERROR', 'INVALID_FILENAME'].includes(code ?? ''))
				|| (cause.status === 401 && code === 'UNAUTHORIZED')
				|| (cause.status === 403 && code === 'FORBIDDEN')
				|| (cause.status === 404 && code === 'NOT_FOUND')
				|| (cause.status === 413 && code === 'PAYLOAD_TOO_LARGE')
				|| (cause.status === 415 && code === 'UNSUPPORTED_MEDIA_TYPE');
			Object.assign(cause, { rejectedBeforeCreation, uncertain: !rejectedBeforeCreation });
			throw cause;
		}
		throw new DirectUploadCreateError(true, cause);
	}
}
const CONTROL_RETRY_ATTEMPTS = 4;
const UPLOAD_PART_RETRY_ATTEMPTS = 4;

function throwIfAborted(signal?: AbortSignal | null): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

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

async function apiRequest<T>(
	path: string,
	init: RequestInit = {},
	retrySignal?: AbortSignal,
): Promise<T> {
	const effectiveRetrySignal = retrySignal ?? init.signal;
	throwIfAborted(effectiveRetrySignal);

	const transport = import.meta.env.VITE_MOCK === 'true'
		? (await import('./mock/transport')).mockFetch : fetch;
	const url = import.meta.env.VITE_MOCK === 'true' ? path : `${env.API_BASE_URL}${path}`;
	for (let attempt = 0; ; attempt += 1) {
		throwIfAborted(effectiveRetrySignal);
		const res = await transport(url, { ...init, credentials: 'include' });
		if (res.ok) {
			if (res.status === 204) {
				throwIfAborted(init.signal);
				return undefined as T;
			}
			const json = await res.json() as Record<string, unknown>;
			throwIfAborted(init.signal);
			if (json.ok && json.data) return json.data as T;
			return json as T;
		}

		// Create keeps its transport alive after a local pause/cancel. Preserve
		// a late rejection as well as a late success, while still stopping retries.
		throwIfAborted(init.signal ?? effectiveRetrySignal);
		let body: unknown;
		try { body = await res.json(); } catch { body = null; }
		throwIfAborted(init.signal ?? effectiveRetrySignal);
		if (res.status !== 429 || attempt >= CONTROL_RETRY_ATTEMPTS) {
			throw new ApiError(res.status, res.statusText, body);
		}
		await wait(
			retryAfterMs(res.headers.get('retry-after'), Math.min(30_000, 1_000 * (2 ** attempt))),
			effectiveRetrySignal,
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
	await apiRequest<void>(`/api/admin/direct-asset-upload-sessions/${sessionId}`, { method: 'DELETE', signal: AbortSignal.timeout(15_000) });
}

/** Poll JSON control state only; Garage never passes archive bytes through the API. */
export async function waitForDirectAssetReady(
	sessionId: string,
	options: { intervalMs?: number; maxIntervalMs?: number; timeoutMs?: number; signal?: AbortSignal; onStatus?: (status: DirectAssetUploadStatus) => void } = {},
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
		options.onStatus?.(status);
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
	signal?: AbortSignal,
	onProgress?: (bytes: number) => void,
): Promise<string> {
	throwIfAborted(signal);

	let response: { ok: boolean; status: number; headers: Pick<Headers, 'get'> };
	try {
		response = await putUploadPart(capability, body, signal, onProgress);
	} catch (error) {
		throwIfAborted(signal);
		if (isAbortError(error)) throw error;
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
	signal?: AbortSignal,
): Promise<Map<number, PartCapability>> {
	throwIfAborted(signal);
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
		signal,
	);
	throwIfAborted(signal);
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
	signal?: AbortSignal,
	onProgress?: (bytes: number) => void,
): Promise<string> {
	let capability = initialCapability;
	for (let attempt = 0; ; attempt += 1) {
		throwIfAborted(signal);
		try {
			onProgress?.(0);
			return await putDirectUploadPart(capability, part.body, signal, onProgress);
		} catch (error) {
			onProgress?.(0);
			throwIfAborted(signal);
			if (isAbortError(error)) throw error;
			if (!(error instanceof DirectUploadPartError) || attempt >= UPLOAD_PART_RETRY_ATTEMPTS) throw error;
			if (error.status === 429) {
				await wait(error.retryAfterMilliseconds ?? Math.min(30_000, 1_000 * (2 ** attempt)), signal);
				continue;
			}
			if (error.status !== 0 && error.status !== 401 && error.status !== 403 && error.status < 500) throw error;
			await wait(Math.min(8_000, 500 * (2 ** attempt)), signal);
			const refreshed = await requestPartCapabilities(session, [part], signal);
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
		clientUploadId?: string;
		createRequest?: DirectUploadCreateRequest;
		onCreateRequest?: (request: DirectUploadCreateRequest) => void;
		/** Position in the widget's sequential file list, persisted for restoration. */
		recoveryIndex?: number;
		onSession?: (session: DirectAssetUploadSession) => void;
		submissionItem?: { id: string; clientToken: string };
		voteId?: string;
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
	const initialProgress = (phase: DirectAssetUploadProgress['phase']) => onProgress?.({ phase, uploadedChunks: 0, totalChunks: 0, uploadedBytes: 0, confirmedBytes: 0, inFlightBytes: 0, totalBytes: file.size, percent: 0 });
	initialProgress('checking');
	const source = await createFileSourceIdentity(file, { signal: options.signal });
	initialProgress('preparing');
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
		const request: DirectUploadCreateRequest = options.createRequest ?? {
			clientUploadId: options.clientUploadId ?? crypto.randomUUID(),
			originalName: file.name, totalBytes: file.size, declaredMimeType: file.type || undefined,
			...source,
			...(options.submissionItem ? { submissionItem: options.submissionItem } : {}),
			...(options.voteId ? { voteId: options.voteId } : {}),
		};
		if (request.originalName !== file.name || request.totalBytes !== file.size || request.sourceIdentity !== source.sourceIdentity) {
			throw new Error('중단된 업로드와 선택한 파일이 다릅니다. 기존 업로드를 먼저 취소해 주세요.');
		}
		// Persistence failures stop here, before any server-side allocation.
		options.onCreateRequest?.(request);
		const created = await createDirectAssetUploadSession(owner, kind, request, options.signal);
		if (created.state === 'ALLOCATING') throw new DirectUploadAllocationPendingError();
		session = { ...created, kind };
		options.onSession?.(session);
		throwIfAborted(options.signal);
		if (created.state === 'READY' || created.state === 'VERIFYING' || created.state === 'COMPLETING') {
			return { status: created.state === 'READY' ? 'READY' : 'VERIFYING', sessionId: session.sessionId, generation: session.generation, sizeBytes: file.size };
		}
		if (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(created.state)) throw new Error(`업로드가 종료되었습니다 (${created.state}). 새 업로드 시작 전에 상태를 확인해 주세요.`);

	}
	if (options.resume) options.onSession?.(session);
	throwIfAborted(options.signal);
	const parts: DirectGameUploadCompleteRequest['parts'] = [...uploaded.entries()]
		.map(([partNumber, part]) => ({ partNumber, ...part }))
		.sort((a, b) => a.partNumber - b.partNumber);
	let uploadedBytes = parts.reduce((total, part) => total + part.sizeBytes, 0);
	const report = (phase: DirectAssetUploadProgress['phase'], inFlightBytes = 0) => onProgress?.({
		phase, uploadedChunks: parts.length, totalChunks: session.totalParts,
		confirmedBytes: uploadedBytes, inFlightBytes, uploadedBytes: uploadedBytes + inFlightBytes,
		totalBytes: file.size, percent: Math.min(parts.length === session.totalParts ? 100 : 99, Math.floor((uploadedBytes + inFlightBytes) / file.size * 100)),
	});
	report('uploading');
	const pendingPartNumbers = Array.from({ length: session.totalParts }, (_, index) => index + 1)
		.filter((partNumber) => !uploaded.has(partNumber));
	for (let offset = 0; offset < pendingPartNumbers.length; offset += DIRECT_UPLOAD_BROWSER_PART_BATCH_SIZE) {
		throwIfAborted(options.signal);
		const batchNumbers = pendingPartNumbers.slice(offset, offset + DIRECT_UPLOAD_BROWSER_PART_BATCH_SIZE);
		const prepared: PreparedPart[] = [];
		for (const partNumber of batchNumbers) {
			throwIfAborted(options.signal);
			const start = (partNumber - 1) * session.partSizeBytes;
			const body = file.slice(start, Math.min(start + session.partSizeBytes, file.size));
			const bytes = await body.arrayBuffer();
			throwIfAborted(options.signal);
			const checksum = await crypto.subtle.digest('SHA-256', bytes);
			throwIfAborted(options.signal);
			prepared.push({
				partNumber,
				body,
				checksumSha256: checksumBase64(checksum),
			});
		}
		const capabilities = await requestPartCapabilities(session, prepared, options.signal);
		for (const part of prepared) {
			throwIfAborted(options.signal);
			const capability = capabilities.get(part.partNumber);
			if (!capability) throw new Error('Direct upload capability was not issued');
			const etag = await putPartWithBoundedRetry(session, part, capability, options.signal, bytes => report('uploading', bytes));
			parts.push({ partNumber: part.partNumber, etag, sizeBytes: part.body.size });
			uploadedBytes += part.body.size;
			report(parts.length === session.totalParts ? 'transferred' : 'uploading');
			throwIfAborted(options.signal);
		}
	}
	parts.sort((a, b) => a.partNumber - b.partNumber);
	throwIfAborted(options.signal);
	report('completing');
	const completion = await apiRequest<DirectGameUploadCompletionResponse>(`/api/admin/direct-asset-upload-sessions/${session.sessionId}/complete`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ generation: session.generation, parts } satisfies DirectGameUploadCompleteRequest),
	}, options.signal);
	throwIfAborted(options.signal);
	report(completion.status === 'READY' ? 'ready' : 'verifying');
	return completion;
}
