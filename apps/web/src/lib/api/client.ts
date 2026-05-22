// ── 공통 API 클라이언트 ──────────────────────────────────────
// 모든 API 호출은 이 계층을 통과한다.

import { env } from '../env';
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
  // Mock 모드: VITE_MOCK=true이면 실제 API를 호출하지 않고 mock 데이터를 반환한다.
  // 프로덕션 빌드에서는 이 분기가 dead code로 제거된다.
  if (import.meta.env.VITE_MOCK === 'true') {
    const { handleMockRequest } = await import('./mock/handler');
    return handleMockRequest<T>(path, options);
  }

  const url = `${env.API_BASE_URL}${path}`;
  const { body, headers: customHeaders, ...rest } = options;

  const headers = new Headers(customHeaders);

  let resolvedBody: BodyInit | undefined;

  if (body instanceof FormData) {
    // FormData → 브라우저가 Content-Type + boundary 자동 설정
    resolvedBody = body;
  } else if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    resolvedBody = JSON.stringify(body);
  }

  const response = await fetch(url, {
    ...rest,
    headers,
    body: resolvedBody,
    credentials: 'include', // HttpOnly cookie session
  });

  if (!response.ok) {
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = await response.text().catch(() => null);
    }
    throw new ApiError(response.status, response.statusText, errorBody);
  }

  // 204 No Content 등
  if (response.status === 204) {
    return undefined as T;
  }

  const json = (await response.json()) as unknown;

  // 백엔드가 { ok: true, data: T } envelope로 감싸므로 data 필드를 꺼낸다.
  if (
    typeof json === 'object' &&
    json !== null &&
    'ok' in json &&
    'data' in json &&
    (json as Record<string, unknown>).ok === true
  ) {
    return (json as { data: T }).data;
  }

  return json as T;
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
		return request<T>(path, { method: options.method ?? 'POST', body: formData })
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

		xhr.onload = () => {
			if (xhr.status < 200 || xhr.status >= 300) {
				let errorBody: unknown = xhr.responseText;
				try { errorBody = JSON.parse(xhr.responseText); } catch { /* keep text */ }
				if (taskId) failUpload(taskId, getApiErrorMessage(new ApiError(xhr.status, xhr.statusText, errorBody)));
				reject(new ApiError(xhr.status, xhr.statusText, errorBody));
				return;
			}

			if (xhr.status === 204) {
				if (taskId) finishUpload(taskId);
				resolve(undefined as T);
				return;
			}

			let json: unknown;
			try {
				json = JSON.parse(xhr.responseText);
			} catch {
				if (taskId) finishUpload(taskId);
				resolve(xhr.responseText as T);
				return;
			}

			if (
				typeof json === 'object' &&
				json !== null &&
				'ok' in json &&
				'data' in json &&
				(json as Record<string, unknown>).ok === true
			) {
				if (taskId) finishUpload(taskId);
				resolve((json as { data: T }).data);
				return;
			}

			if (taskId) finishUpload(taskId);
			resolve(json as T);
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

export function getApiErrorMessage(err: unknown): string {
  if (isApiError(err)) {
    if (typeof err.body === 'object' && err.body !== null) {
      const body = err.body as Record<string, unknown>;
      // 백엔드 에러 형식: { ok: false, error: { code, message } }
      if (
        typeof body.error === 'object' &&
        body.error !== null &&
        'message' in body.error &&
        typeof (body.error as Record<string, unknown>).message === 'string'
      ) {
        return ((body.error as Record<string, unknown>).message as string);
      }
      if (typeof body.message === 'string') return body.message;
    }
    return err.statusText;
  }
  if (err instanceof Error) return err.message;
  return '알 수 없는 오류가 발생했습니다.';
}
