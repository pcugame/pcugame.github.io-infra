import { open, rm } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ImageInfrastructureError, ImageRejectedError } from './errors.js';

function assertBudget(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new ImageInfrastructureError(`${label} must be a positive safe integer`);
	}
}

/**
 * A synchronous shared counter makes admission of a chunk indivisible across
 * every output in one workspace. Image encoders currently run sequentially,
 * but the counter also remains safe if that implementation changes later.
 */
export class AggregateOutputBudget {
	readonly limitBytes: number;
	#usedBytes = 0;

	constructor(limitBytes: number) {
		assertBudget(limitBytes, 'Aggregate image output budget');
		this.limitBytes = limitBytes;
	}

	get usedBytes(): number { return this.#usedBytes; }

	reserve(bytes: number, fileUsedBytes: number, fileLimitBytes: number): void {
		if (!Number.isSafeInteger(bytes) || bytes < 0) {
			throw new ImageInfrastructureError('Image output chunk size is invalid');
		}
		if (bytes > fileLimitBytes - fileUsedBytes || bytes > this.limitBytes - this.#usedBytes) {
			throw new ImageRejectedError('Generated image output exceeded its write-time budget', 'RESOURCE_LIMIT');
		}
		this.#usedBytes += bytes;
	}
}

/**
 * Creates a new regular file exclusively and admits bytes before they reach
 * disk. Any failure removes the partial file after its descriptor is closed.
 */
export async function writeBoundedOutput(input: {
	source: Readable;
	destination: string;
	fileLimitBytes: number;
	aggregateBudget: AggregateOutputBudget;
	signal?: AbortSignal;
	onCreate?: () => void;
}): Promise<number> {
	assertBudget(input.fileLimitBytes, 'Per-file image output budget');
	let fileUsedBytes = 0;
	let created = false;
	let handle;
	try {
		handle = await open(input.destination, 'wx', 0o600);
	} catch (error) {
		throw new ImageRejectedError('Image output destination is not a new regular file', 'RESOURCE_LIMIT', { cause: error });
	}
	created = true;
	input.onCreate?.();
	try {
		const limiter = new Transform({
			transform(chunk: Buffer | string, _encoding, callback) {
				try {
					const bytes = Buffer.byteLength(chunk);
					input.aggregateBudget.reserve(bytes, fileUsedBytes, input.fileLimitBytes);
					fileUsedBytes += bytes;
					callback(null, chunk);
				} catch (error) { callback(error as Error); }
			},
		});
		const destination = handle.createWriteStream({ autoClose: true });
		if (input.signal) {
			await pipeline(input.source, limiter, destination, { signal: input.signal });
		} else {
			await pipeline(input.source, limiter, destination);
		}
		return fileUsedBytes;
	} catch (error) {
		await handle.close().catch(() => undefined);
		if (created) await rm(input.destination, { force: true }).catch(() => undefined);
		throw error;
	} finally {
		await handle.close().catch(() => undefined);
	}
}
