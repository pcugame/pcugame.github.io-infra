// ── 공통 API 클라이언트 ──────────────────────────────────────
// 모든 API 호출은 이 계층을 통과한다.

import { env } from '../env';
import { hydrateFileUrls } from './file-access';
import { failUpload, finishUpload, startUpload, updateUpload } from '../upload';
import type { UploadFormDataOptions } from '../upload';

// ── 에러 타입 ────────────────────────────────────────────────

export class ApiError extends Error {
  status: number;
  statusText: string;
  body: unknown;

  constructor(status: number, statusText: string, body: unknown) {
    super(`API ${status}: ${statusText}`);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

// ── 기본 fetch 래퍼 ──────────────────────────────────────────

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = `${env.API_BASE_URL}${path}`;
  const { body, headers: customHeaders, ...rest } = options;

  const headers = new Headers(customHeaders);

  let resolvedBody: BodyInit | undefined;

  if (body instanceof FormData || body instanceof Blob) {
    // FormData → 브라우저가 Content-Type + boundary 자동 설정
    resolvedBody = body;
  } else if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    resolvedBody = JSON.stringify(body);
  }

  const transport = import.meta.env.VITE_MOCK === 'true'
    ? (await import('./mock/transport')).mockFetch : fetch;
  const response = await transport(import.meta.env.VITE_MOCK === 'true' ? path : url, {
    ...rest,
    headers,
    body: resolvedBody,
    credentials: 'include', // HttpOnly cookie session
  });

  const text = response.status === 204 ? '' : await response.text();
  return decodeApiResponse<T>(path, response.status, response.statusText, text);
}

/** API protocol handling shared by fetch and FormData XHR. Storage parts use their own protocol. */
async function decodeApiResponse<T>(path: string, status: number, statusText: string, text: string): Promise<T> {
  const success = status >= 200 && status < 300;
  if (success && status === 204) return undefined as T;

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    if (success) throw new ApiError(status, 'Invalid JSON response', text);
    body = text;
  }
  if (!success) throw new ApiError(status, statusText, body);

  if (typeof body === 'object' && body !== null && 'ok' in body && body.ok === true && 'data' in body) {
    const data = body.data as T;
    const isMediaRead = /^\/api\/(public\/(years|exhibitions|projects)|admin\/(exhibitions|projects|change-requests)|me\/(projects|change-requests))(\/|\?|$)/.test(path);
    return isMediaRead ? hydrateFileUrls(data) : data;
  }
  return body as T;
}

// ── HTTP 메서드 헬퍼 ─────────────────────────────────────────

export const api = {
  get<T>(path: string, opts?: RequestOptions) {
    return request<T>(path, { ...opts, method: 'GET' });
  },
  post<T>(path: string, body?: unknown, opts?: RequestOptions) {
    return request<T>(path, { ...opts, method: 'POST', body });
  },
  patch<T>(path: string, body?: unknown, opts?: RequestOptions) {
    return request<T>(path, { ...opts, method: 'PATCH', body });
  },
  put<T>(path: string, body?: unknown, opts?: RequestOptions) {
    return request<T>(path, { ...opts, method: 'PUT', body });
  },
  delete<T>(path: string, opts?: RequestOptions & { body?: unknown }) {
    return request<T>(path, { ...opts, method: 'DELETE' });
  },
};

export function uploadFormData<T>(
	path: string,
	formData: FormData,
	options: UploadFormDataOptions,
): Promise<T> {
	const hasFiles = hasBinaryFormData(formData);
	const taskId = hasFiles
		? startUpload({
			title: options.title,
			phase: 'preparing',
			processingMessage: options.processingMessage,
		})
		: null;

	if (import.meta.env.VITE_MOCK === 'true') {
		return request<T>(path, {
			method: options.method ?? 'POST',
			body: formData,
			headers: options.headers,
		})
			.then((result) => {
				if (taskId) finishUpload(taskId);
				return result;
			})
			.catch((err) => {
				if (taskId) failUpload(taskId, getApiErrorMessage(err));
				throw err;
			});
	}

	return new Promise<T>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open(options.method ?? 'POST', `${env.API_BASE_URL}${path}`);
		xhr.withCredentials = true;
		for (const [name, value] of Object.entries(options.headers ?? {})) {
			xhr.setRequestHeader(name, value);
		}

		if (taskId) {
			updateUpload(taskId, { phase: 'uploading' });
		}

		xhr.upload.onprogress = (event) => {
			if (!taskId || !event.lengthComputable) return;
			const percent = Math.min(99, Math.round((event.loaded / event.total) * 100));
			updateUpload(taskId, {
				phase: 'uploading',
				loadedBytes: event.loaded,
				totalBytes: event.total,
				percent,
			});
		};

		xhr.upload.onload = () => {
			if (!taskId) return;
			updateUpload(taskId, {
				phase: 'processing',
				percent: 99,
			});
		};

		xhr.onload = async () => {
			try {
				const data = await decodeApiResponse<T>(path, xhr.status, xhr.statusText, xhr.responseText);
				if (taskId) finishUpload(taskId);
				resolve(data);
			} catch (err) {
				if (taskId) failUpload(taskId, getApiErrorMessage(err));
				reject(err);
			}
		};

		xhr.onerror = () => {
			const err = new ApiError(0, 'Network Error', null);
			if (taskId) failUpload(taskId, getApiErrorMessage(err));
			reject(err);
		};
		xhr.onabort = () => {
			const err = new ApiError(0, 'Upload aborted', null);
			if (taskId) failUpload(taskId, getApiErrorMessage(err));
			reject(err);
		};
		xhr.send(formData);
	});
}

function hasBinaryFormData(formData: FormData): boolean {
	if (typeof Blob === 'undefined') return false;
	for (const value of formData.values()) {
		if (value instanceof Blob) return true;
	}
	return false;
}

// ── 에러 판정 유틸 ───────────────────────────────────────────

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

function getApiErrorPayload(err: unknown): Record<string, unknown> | null {
  if (!isApiError(err) || typeof err.body !== 'object' || err.body === null) {
    return null;
  }

  const body = err.body as Record<string, unknown>;
  if (typeof body.error === 'object' && body.error !== null) {
    return body.error as Record<string, unknown>;
  }

  return null;
}

export function getApiErrorCode(err: unknown): string | undefined {
  const error = getApiErrorPayload(err);
  return typeof error?.code === 'string' ? error.code : undefined;
}

export function getApiErrorMessage(err: unknown): string {
  if (isApiError(err)) {
    const error = getApiErrorPayload(err);
    if (typeof error?.message === 'string') return error.message;

    if (typeof err.body === 'object' && err.body !== null) {
      const body = err.body as Record<string, unknown>;
      if (typeof body.message === 'string') return body.message;
    }
    return err.statusText;
  }
  if (err instanceof Error) return err.message;
  return '알 수 없는 오류가 발생했습니다.';
}
