import type { z } from 'zod';
import { MockHttpError, type MockRequestOptions } from './context';

export function bodyObject(options: MockRequestOptions): Record<string, unknown> {
  let value = options.body;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new MockHttpError(400, 'VALIDATION_ERROR', 'Invalid JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Blob || value instanceof FormData)
    throw new MockHttpError(400, 'VALIDATION_ERROR', 'An object body is required');
  return value as Record<string, unknown>;
}
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new MockHttpError(400, 'VALIDATION_ERROR', result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
}
export function allowMethod(method: string, ...allowed: string[]): void {
  if (!allowed.includes(method)) throw new MockHttpError(404, 'NOT_FOUND', `Unsupported method ${method}`);
}
export function conflict(message: string): never { throw new MockHttpError(409, 'CONFLICT', message); }
export function forbidden(message = 'Access denied'): never { throw new MockHttpError(403, 'FORBIDDEN', message); }
export function missing(message = 'Not found'): never { throw new MockHttpError(404, 'NOT_FOUND', message); }
