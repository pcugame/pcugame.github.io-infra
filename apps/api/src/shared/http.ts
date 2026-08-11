import type { FastifyReply } from 'fastify';
import type { ApiErrorCode } from '@pcu/contracts';

export interface ApiSuccess<T = unknown> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

export function sendOk<T>(reply: FastifyReply, data: T, status = 200): void {
  const body: ApiSuccess<T> = { ok: true, data };
  reply.status(status).send(body);
}

export function sendCreated<T>(reply: FastifyReply, data: T): void {
  sendOk(reply, data, 201);
}

export function sendError(
  reply: FastifyReply,
  status: number,
  message: string,
  code: ApiErrorCode = 'ERROR',
  details?: unknown,
): void {
  const body: ApiError = { ok: false, error: { code, message, details } };
  reply.status(status).send(body);
}
