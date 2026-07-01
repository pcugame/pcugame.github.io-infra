import { Transform, type Readable } from 'node:stream';
import { badRequest, AppError } from '../../../shared/errors.js';

export function chunkByteLength(chunk: unknown, encoding: BufferEncoding): number {
	if (Buffer.isBuffer(chunk)) return chunk.length;
	if (chunk instanceof Uint8Array) return chunk.byteLength;
	if (typeof chunk === 'string') return Buffer.byteLength(chunk, encoding);
	return 0;
}

export function toError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

export function createCountedChunkStream(
	body: NodeJS.ReadableStream,
	chunkIndex: number,
	expectedSize: number,
): { stream: Readable; bytesWritten: () => number; destroy: (err?: unknown) => void } {
	const source = body as Readable;
	let written = 0;

	const counter = new Transform({
		transform(chunk, encoding, callback) {
			written += chunkByteLength(chunk, encoding as BufferEncoding);
			if (written > expectedSize) {
				callback(new AppError(413, `Chunk ${chunkIndex} exceeds expected size`, 'PAYLOAD_TOO_LARGE'));
				return;
			}
			callback(null, chunk);
		},
		flush(callback) {
			if (written !== expectedSize) {
				callback(badRequest(`Chunk ${chunkIndex}: expected ${expectedSize} bytes, got ${written}`));
				return;
			}
			callback();
		},
	});

	source.once('error', (err) => counter.destroy(err));
	counter.once('error', () => {
		if (!source.destroyed) source.destroy();
	});
	source.pipe(counter);

	return {
		stream: counter,
		bytesWritten: () => written,
		destroy: (err?: unknown) => {
			const error = err == null ? undefined : toError(err);
			if (!counter.destroyed) counter.destroy(error);
			if (!source.destroyed) source.destroy(error);
		},
	};
}
