import { AsyncLocalStorage } from 'node:async_hooks';
import type pino from 'pino';

/**
 * Per-request state propagated through the async call chain. Fastify creates a fresh
 * async resource per HTTP request, so the store stays bound to whichever request
 * initially called `enterWith`.
 *
 * Kept deliberately tiny — the whole point is that the store is cheap to enter on
 * every request. Add fields here only when every handler must see them (e.g. user
 * id after auth resolves).
 */
export interface RequestContext {
	reqId: string;
	log: pino.Logger;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Returns the current request's context if called from inside an HTTP request,
 * otherwise `undefined` (e.g. at boot time or inside background jobs). */
export function currentContext(): RequestContext | undefined {
	return requestContext.getStore();
}
