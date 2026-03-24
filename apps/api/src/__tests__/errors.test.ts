import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { AppError, badRequest, notFound, forbidden, conflict } from '../shared/errors.js';
import { parseBody } from '../shared/validation.js';

describe('AppError', () => {
  it('has correct properties', () => {
    const err = new AppError(400, 'Bad input', 'BAD_INPUT', { field: 'x' });
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('Bad input');
    expect(err.code).toBe('BAD_INPUT');
    expect(err.details).toEqual({ field: 'x' });
    expect(err).toBeInstanceOf(Error);
  });

  it('factory functions produce correct status codes', () => {
    expect(badRequest('msg').statusCode).toBe(400);
    expect(notFound('msg').statusCode).toBe(404);
    expect(forbidden('msg').statusCode).toBe(403);
    expect(conflict('msg').statusCode).toBe(409);
  });
});

describe('parseBody', () => {
  const schema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
  });

  it('returns parsed data on valid input', () => {
    const result = parseBody(schema, { name: 'Test', age: 25 });
    expect(result).toEqual({ name: 'Test', age: 25 });
  });

  it('throws AppError with VALIDATION_ERROR code on invalid input', () => {
    try {
      parseBody(schema, { name: '', age: -1 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.statusCode).toBe(400);
      expect(appErr.code).toBe('VALIDATION_ERROR');
      expect(appErr.details).toBeDefined();
    }
  });

  it('throws on completely wrong input', () => {
    expect(() => parseBody(schema, null)).toThrow(AppError);
    expect(() => parseBody(schema, 'string')).toThrow(AppError);
  });
});
