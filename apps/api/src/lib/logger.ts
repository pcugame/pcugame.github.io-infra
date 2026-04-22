import pino from 'pino';
import { env } from '../config/env.js';
import { currentContext } from './request-context.js';

let _root: pino.Logger | undefined;

/**
 * The process-wide root logger. Call this only when you specifically need to bypass
 * the per-request child logger — typically at boot/shutdown (`server.ts`) or from
 * background jobs that run outside any request context. Everywhere else, use
 * {@link logger} and let the request context attach its reqId automatically.
 */
export function rootLogger(): pino.Logger {
	if (!_root) {
		const e = env();
		_root = pino({
			level: e.LOG_LEVEL,
			...(e.NODE_ENV === 'development'
				? { transport: { target: 'pino-pretty', options: { colorize: true } } }
				: {}),
		});
	}
	return _root;
}

/**
 * Logger entry point for the whole codebase.
 *
 * Inside an HTTP request the Fastify `onRequest` hook seeds an AsyncLocalStorage
 * context with a child logger bound to `{ reqId }` — this function returns that
 * child so every log line carries the correlation id. Outside a request (e.g.
 * startup code, orphan reaper, SIGTERM handler) the ALS store is empty, so we
 * fall back to the root logger.
 *
 * Callers never need to care which mode is active; the shape is identical.
 */
export function logger(): pino.Logger {
	return currentContext()?.log ?? rootLogger();
}
