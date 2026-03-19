import type { FastifyReply } from 'fastify';

export interface ApiSuccess<T = unknown> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
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
  code = 'ERROR',
  details?: unknown,
): void {
  const body: ApiError = { ok: false, error: { code, message, details } };
  reply.status(status).send(body);
}
