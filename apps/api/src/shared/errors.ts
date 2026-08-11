import type { ApiErrorCode } from '@pcu/contracts';

export const API_ERROR_CODES = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  EMAIL_DOMAIN_NOT_ALLOWED: 'EMAIL_DOMAIN_NOT_ALLOWED',
} as const satisfies Record<string, ApiErrorCode>;

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: ApiErrorCode,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function badRequest(
  message: string,
  code?: ApiErrorCode,
  details?: unknown,
): AppError {
  return new AppError(400, message, code, details);
}

export function unauthorized(message = 'Unauthorized'): AppError {
  return new AppError(401, message, API_ERROR_CODES.UNAUTHORIZED);
}

export function forbidden(
  message = 'Forbidden',
  code: ApiErrorCode = 'FORBIDDEN',
): AppError {
  return new AppError(403, message, code);
}

export function notFound(message = 'Not found'): AppError {
  return new AppError(404, message, 'NOT_FOUND');
}

export function conflict(message: string): AppError {
  return new AppError(409, message, 'CONFLICT');
}

export function idempotencyConflict(message = 'Idempotency key was already used for another request'): AppError {
  return new AppError(409, message, 'IDEMPOTENCY_CONFLICT');
}

export function operationInProgress(message = 'An operation with this idempotency key is still in progress'): AppError {
  return new AppError(409, message, 'OPERATION_IN_PROGRESS');
}

export function payloadTooLarge(message = 'Payload too large'): AppError {
  return new AppError(413, message, 'PAYLOAD_TOO_LARGE');
}

export function unsupportedMediaType(message = 'Unsupported media type'): AppError {
  return new AppError(415, message, 'UNSUPPORTED_MEDIA_TYPE');
}

/**
 * Detect a Prisma unique-constraint violation (P2002), optionally scoped to a specific target.
 * `target` matches either the constraint name or any field name in err.meta.target.
 */
export function isUniqueConstraintError(err: unknown, target?: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; meta?: { target?: unknown } };
  if (e.code !== 'P2002') return false;
  if (!target) return true;
  const t = e.meta?.target;
  if (typeof t === 'string') return t === target || t.includes(target);
  if (Array.isArray(t)) return t.includes(target);
  return false;
}
