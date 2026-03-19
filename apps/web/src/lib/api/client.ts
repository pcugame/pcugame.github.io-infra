// ── 공통 API 클라이언트 ──────────────────────────────────────
// 모든 API 호출은 이 계층을 통과한다.

import { env } from '../env';

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
  delete<T>(path: string, opts?: RequestOptions) {
    return request<T>(path, { ...opts, method: 'DELETE' });
  },
};

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
