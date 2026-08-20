import { Transform } from 'node:stream';
import type { RequestPayload } from 'fastify';
import { payloadTooLarge } from './errors.js';

interface RequestLocalEncodedLimitState {
	__pcuEncodedMultipartLimitExceeded?: true;
}

/** Convert the downstream premature-close error back into the ingress error. */
export function rethrowEncodedMultipartError(
	payload: object,
	maxBytes: number,
	error: unknown,
): never {
	if ((payload as RequestLocalEncodedLimitState).__pcuEncodedMultipartLimitExceeded) {
		throw payloadTooLarge(`Inline upload request exceeds ${maxBytes} bytes`);
	}
	throw error;
}

/**
 * Client multipart ingress inventory:
 * - project POST /projects/:id/assets
 * - admin POST /exhibitions/:id/poster
 * - admin POST /import/preview and /import/execute
 *
 * Fastify's multipart parser owns its own stream, so route `bodyLimit` alone
 * does not bound encoded multipart bytes. Every route above must install this
 * preParsing limiter before Busboy can consume or persist a complete file.
 */
export function limitEncodedMultipartBody(
	payload: RequestPayload,
	maxBytes: number,
): RequestPayload {
	let receivedEncodedLength = 0;
	const pipeRaw = payload.pipe.bind(payload);
	const limiter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			receivedEncodedLength += chunk.length;
			if (receivedEncodedLength > maxBytes) {
				Object.defineProperty(payload, '__pcuEncodedMultipartLimitExceeded', {
					configurable: true,
					value: true,
				});
				callback(payloadTooLarge(`Inline upload request exceeds ${maxBytes} bytes`));
				return;
			}
			callback(null, chunk);
		},
	});
	Object.defineProperty(limiter, 'receivedEncodedLength', {
		enumerable: true,
		get: () => receivedEncodedLength,
	});
	// @fastify/multipart's deferred `request.parts()` parser pipes from
	// request.raw rather than from Fastify's returned preParsing payload. Route
	// the raw request's subsequent Busboy pipe through the same limiter too;
	// otherwise a handler could finish while an unconsumed limiter is still
	// counting in the background. This makes the cap a physical ingress gate.
	payload.pipe = ((destination: NodeJS.WritableStream, options?: { end?: boolean }) => {
		limiter.once('error', (error) => {
			if ('destroy' in destination && typeof destination.destroy === 'function') {
				destination.destroy(error);
			}
		});
		return limiter.pipe(destination, options);
	}) as typeof payload.pipe;
	payload.unpipe = ((destination?: NodeJS.WritableStream) => {
		limiter.unpipe(destination);
		return payload;
	});
	payload.once('error', (error) => limiter.destroy(error));
	// Defer flowing until Fastify/Busboy has attached its error listener to the
	// returned stream. An immediately available request can otherwise emit the
	// limit error inside this hook and leave the request without a response.
	setImmediate(() => {
		if (!limiter.destroyed) pipeRaw(limiter);
	});
	return limiter;
}
