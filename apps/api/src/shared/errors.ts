export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function badRequest(message: string, code?: string): AppError {
  return new AppError(400, message, code);
}

export function unauthorized(message = 'Unauthorized'): AppError {
  return new AppError(401, message, 'UNAUTHORIZED');
}

export function forbidden(message = 'Forbidden'): AppError {
  return new AppError(403, message, 'FORBIDDEN');
}

export function notFound(message = 'Not found'): AppError {
  return new AppError(404, message, 'NOT_FOUND');
}

export function conflict(message: string): AppError {
  return new AppError(409, message, 'CONFLICT');
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
