export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
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
