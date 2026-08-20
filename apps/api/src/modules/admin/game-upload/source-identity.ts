import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, badRequest, conflict } from '../../../shared/errors.js';

export const SOURCE_IDENTITY_ALGORITHM = 'SHA256_BLOCK_MANIFEST_V1' as const;
export const SOURCE_IDENTITY_BLOCK_SIZE_BYTES = 1_048_576 as const;
const ROOT_PREFIX = Buffer.from('PCU-UPLOAD-SOURCE-V1\0', 'utf8');
const HEX_SHA256 = /^[a-f0-9]{64}$/;

export type SourceIdentityInput = {
	sourceIdentityAlgorithm?: string;
	sourceIdentity?: string;
	sourceIdentityBlockSizeBytes?: number;
	sourceIdentityBlockDigests?: string[];
};

function manifestBuffer(digests: string[]): Buffer {
	return Buffer.concat(digests.map((digest) => Buffer.from(digest, 'hex')));
}

export function sourceIdentityRoot(totalBytes: number, blockSizeBytes: number, digests: string[]): string {
	const header = Buffer.allocUnsafe(8 + 4 + 4);
	header.writeBigUInt64BE(BigInt(totalBytes), 0);
	header.writeUInt32BE(blockSizeBytes, 8);
	header.writeUInt32BE(digests.length, 12);
	return createHash('sha256').update(ROOT_PREFIX).update(header).update(manifestBuffer(digests)).digest('hex');
}

export function validateSourceIdentity(input: SourceIdentityInput, totalBytes: number): {
	algorithm: typeof SOURCE_IDENTITY_ALGORITHM;
	identity: string;
	blockSizeBytes: typeof SOURCE_IDENTITY_BLOCK_SIZE_BYTES;
	manifest: Buffer;
} {
	if (input.sourceIdentityAlgorithm !== SOURCE_IDENTITY_ALGORITHM
		|| input.sourceIdentityBlockSizeBytes !== SOURCE_IDENTITY_BLOCK_SIZE_BYTES
		|| !Array.isArray(input.sourceIdentityBlockDigests)
		|| !HEX_SHA256.test(input.sourceIdentity ?? '')) {
		throw badRequest('Invalid source file identity', 'VALIDATION_ERROR');
	}
	const expectedBlocks = Math.ceil(totalBytes / SOURCE_IDENTITY_BLOCK_SIZE_BYTES);
	if (input.sourceIdentityBlockDigests.length !== expectedBlocks
		|| input.sourceIdentityBlockDigests.some((digest) => !HEX_SHA256.test(digest))) {
		throw badRequest('Invalid source file identity manifest', 'VALIDATION_ERROR');
	}
	const root = sourceIdentityRoot(totalBytes, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, input.sourceIdentityBlockDigests);
	if (root !== input.sourceIdentity) {
		throw badRequest('Source file identity does not match its manifest', 'VALIDATION_ERROR');
	}
	return {
		algorithm: SOURCE_IDENTITY_ALGORITHM,
		identity: root,
		blockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		manifest: manifestBuffer(input.sourceIdentityBlockDigests),
	};
}

export function assertSessionHasSourceIdentity(session: {
	sourceIdentityAlgorithm?: string | null;
	sourceIdentity?: string | null;
	sourceIdentityBlockSizeBytes?: number | null;
	sourceIdentityBlockManifest?: Uint8Array | null;
}): asserts session is typeof session & {
	sourceIdentityAlgorithm: typeof SOURCE_IDENTITY_ALGORITHM;
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: number;
	sourceIdentityBlockManifest: Uint8Array;
} {
	if (session.sourceIdentityAlgorithm !== SOURCE_IDENTITY_ALGORITHM
		|| !HEX_SHA256.test(session.sourceIdentity ?? '')
		|| session.sourceIdentityBlockSizeBytes !== SOURCE_IDENTITY_BLOCK_SIZE_BYTES
		|| !session.sourceIdentityBlockManifest?.length) {
		throw conflict('This upload session has no valid source identity; start a new upload', {
			reason: 'SOURCE_IDENTITY_MISSING',
		});
	}
}

export function assertSourceIdentityMatches(session: Parameters<typeof assertSessionHasSourceIdentity>[0], query: {
	sourceIdentityAlgorithm?: string;
	sourceIdentity?: string;
}): void {
	assertSessionHasSourceIdentity(session);
	if (query.sourceIdentityAlgorithm !== SOURCE_IDENTITY_ALGORITHM || !HEX_SHA256.test(query.sourceIdentity ?? '')) {
		throw badRequest('Invalid source file identity query', 'VALIDATION_ERROR');
	}
	if (query.sourceIdentity !== session.sourceIdentity) {
		throw conflict('Source file identity does not match this upload session', {
			reason: 'SOURCE_IDENTITY_MISMATCH',
		});
	}
}

/**
 * Materialize one protected object GET into worker-local storage while checking
 * the browser's block manifest. Object chunks may have arbitrary boundaries;
 * only one 1 MiB hash state and the storage SDK's bounded stream buffers are
 * resident. Claim renewal is deliberately time-based in the caller rather than
 * coupled to the number of source blocks.
 */
export async function materializeAndValidateCompletedSource(input: {
	totalBytes: bigint;
	sourceIdentityAlgorithm?: string | null;
	sourceIdentity?: string | null;
	sourceIdentityBlockSizeBytes?: number | null;
	sourceIdentityBlockManifest?: Uint8Array | null;
	source: Readable;
	destination: NodeJS.WritableStream;
	signal?: AbortSignal;
	physicalByteLimit: number;
	onBytes?(bytes: number): void;
}): Promise<{ bytesWritten: number }> {
	assertSessionHasSourceIdentity(input);
	const totalBytes = Number(input.totalBytes);
	if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
		throw new Error('Persisted upload size is outside the safe integer range');
	}
	if (!Number.isSafeInteger(input.physicalByteLimit) || input.physicalByteLimit < totalBytes) {
		throw new Error('Validation temp disk budget cannot contain the declared object');
	}
	const blockCount = Math.ceil(totalBytes / SOURCE_IDENTITY_BLOCK_SIZE_BYTES);
	if (input.sourceIdentityBlockManifest.length !== blockCount * 32) {
		throw new Error('Persisted source identity manifest length is invalid');
	}
	const expectedManifest = Buffer.from(input.sourceIdentityBlockManifest);
	const actualDigests: string[] = [];
	let blockHash = createHash('sha256');
	let blockBytes = 0;
	let bytesWritten = 0;

	function finishBlock(): void {
		const block = actualDigests.length;
		const digest = blockHash.digest();
		const expected = expectedManifest.subarray(block * 32, block * 32 + 32);
		if (expected.length !== 32 || !digest.equals(expected)) {
			throw badRequest('Completed object does not match the upload source identity');
		}
		actualDigests.push(digest.toString('hex'));
		blockHash = createHash('sha256');
		blockBytes = 0;
	}

	await pipeline(
		input.source,
		async function* hashAndBound(source) {
			for await (const raw of source) {
				if (input.signal?.aborted) {
					throw input.signal.reason ?? new Error('Validation source stream was aborted');
				}
				const chunk = Buffer.from(raw as Buffer | Uint8Array | string);
				bytesWritten += chunk.length;
				if (bytesWritten > totalBytes || bytesWritten > input.physicalByteLimit) {
					throw new AppError(500, 'Completed source exceeds its declared size', 'SIZE_MISMATCH');
				}
				for (let offset = 0; offset < chunk.length;) {
					const take = Math.min(
						SOURCE_IDENTITY_BLOCK_SIZE_BYTES - blockBytes,
						chunk.length - offset,
					);
					blockHash.update(chunk.subarray(offset, offset + take));
					blockBytes += take;
					offset += take;
					if (blockBytes === SOURCE_IDENTITY_BLOCK_SIZE_BYTES) finishBlock();
				}
				input.onBytes?.(chunk.length);
				yield chunk;
			}
		},
		input.destination,
		...(input.signal ? [{ signal: input.signal }] : []),
	);

	if (bytesWritten !== totalBytes) {
		throw new AppError(
			500,
			`Completed source size mismatch: expected ${totalBytes}, got ${bytesWritten}`,
			'SIZE_MISMATCH',
		);
	}
	if (blockBytes > 0) finishBlock();
	if (actualDigests.length !== blockCount) {
		throw new AppError(500, 'Completed source block count mismatch', 'SIZE_MISMATCH');
	}
	const actualRoot = sourceIdentityRoot(
		totalBytes,
		SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		actualDigests,
	);
	if (actualRoot !== input.sourceIdentity) {
		throw badRequest('Completed object source identity root mismatch');
	}
	return { bytesWritten };
}
