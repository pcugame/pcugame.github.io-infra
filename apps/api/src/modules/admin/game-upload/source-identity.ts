import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, badRequest, conflict } from '../../../shared/errors.js';

export const SOURCE_IDENTITY_ALGORITHM = 'SHA256_BLOCK_MANIFEST_V1' as const;
export const SOURCE_IDENTITY_BLOCK_SIZE_BYTES = 1_048_576 as const;
const ROOT_PREFIX = Buffer.from('PCU-UPLOAD-SOURCE-V1\0', 'utf8');
const SHA256_HEX = /^[a-f0-9]{64}$/;

export type SourceIdentityInput = {
	sourceIdentityAlgorithm?: string;
	sourceIdentity?: string;
	sourceIdentityBlockSizeBytes?: number;
	sourceIdentityBlockDigests?: string[];
};

function asManifest(digests: readonly string[]): Buffer {
	return Buffer.concat(digests.map((digest) => Buffer.from(digest, 'hex')));
}

export function sourceIdentityRoot(totalBytes: number, blockSizeBytes: number, digests: readonly string[]): string {
	const header = Buffer.allocUnsafe(16);
	header.writeBigUInt64BE(BigInt(totalBytes), 0);
	header.writeUInt32BE(blockSizeBytes, 8);
	header.writeUInt32BE(digests.length, 12);
	return createHash('sha256').update(ROOT_PREFIX).update(header).update(asManifest(digests)).digest('hex');
}

export function validateSourceIdentity(input: SourceIdentityInput, totalBytes: number): {
	algorithm: typeof SOURCE_IDENTITY_ALGORITHM;
	identity: string;
	blockSizeBytes: typeof SOURCE_IDENTITY_BLOCK_SIZE_BYTES;
	manifest: Buffer;
} {
	if (input.sourceIdentityAlgorithm !== SOURCE_IDENTITY_ALGORITHM
		|| input.sourceIdentityBlockSizeBytes !== SOURCE_IDENTITY_BLOCK_SIZE_BYTES
		|| !SHA256_HEX.test(input.sourceIdentity ?? '')
		|| !Array.isArray(input.sourceIdentityBlockDigests)) {
		throw badRequest('Invalid source file identity');
	}
	const expectedBlocks = Math.ceil(totalBytes / SOURCE_IDENTITY_BLOCK_SIZE_BYTES);
	if (input.sourceIdentityBlockDigests.length !== expectedBlocks
		|| input.sourceIdentityBlockDigests.some((digest) => !SHA256_HEX.test(digest))) {
		throw badRequest('Invalid source file identity manifest');
	}
	const root = sourceIdentityRoot(totalBytes, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, input.sourceIdentityBlockDigests);
	if (root !== input.sourceIdentity) throw badRequest('Source file identity does not match its manifest');
	return { algorithm: SOURCE_IDENTITY_ALGORITHM, identity: root, blockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES, manifest: asManifest(input.sourceIdentityBlockDigests) };
}

type PersistedSourceIdentity = {
	sourceIdentityAlgorithm?: string | null;
	sourceIdentity?: string | null;
	sourceIdentityBlockSizeBytes?: number | null;
	sourceIdentityBlockManifest?: Uint8Array | null;
};

export function assertSessionHasSourceIdentity(session: PersistedSourceIdentity): asserts session is PersistedSourceIdentity & {
	sourceIdentityAlgorithm: typeof SOURCE_IDENTITY_ALGORITHM;
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: typeof SOURCE_IDENTITY_BLOCK_SIZE_BYTES;
	sourceIdentityBlockManifest: Uint8Array;
} {
	if (session.sourceIdentityAlgorithm !== SOURCE_IDENTITY_ALGORITHM
		|| !SHA256_HEX.test(session.sourceIdentity ?? '')
		|| session.sourceIdentityBlockSizeBytes !== SOURCE_IDENTITY_BLOCK_SIZE_BYTES
		|| !session.sourceIdentityBlockManifest?.length) {
		throw conflict('This upload session has no valid source identity; start a new upload');
	}
}

/** Worker-only single-pass materialization. API code must not call this. */
export async function materializeAndValidateCompletedSource(input: PersistedSourceIdentity & {
	totalBytes: bigint;
	source: Readable;
	destination: NodeJS.WritableStream;
	physicalByteLimit: number;
	signal?: AbortSignal;
	onBytes?(bytes: number): void;
}): Promise<{ bytesWritten: number }> {
	assertSessionHasSourceIdentity(input);
	const totalBytes = Number(input.totalBytes);
	if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || !Number.isSafeInteger(input.physicalByteLimit) || input.physicalByteLimit < totalBytes) {
		throw new Error('Invalid worker materialization size budget');
	}
	const blocks = Math.ceil(totalBytes / SOURCE_IDENTITY_BLOCK_SIZE_BYTES);
	const expectedManifest = Buffer.from(input.sourceIdentityBlockManifest);
	if (expectedManifest.length !== blocks * 32) throw new Error('Persisted source identity manifest length is invalid');
	let bytesWritten = 0;
	let blockBytes = 0;
	let blockHash = createHash('sha256');
	const actual: string[] = [];
	function finishBlock(): void {
		const digest = blockHash.digest();
		if (!digest.equals(expectedManifest.subarray(actual.length * 32, actual.length * 32 + 32))) {
			throw badRequest('Completed object does not match the upload source identity');
		}
		actual.push(digest.toString('hex'));
		blockHash = createHash('sha256');
		blockBytes = 0;
	}
	await pipeline(input.source, async function* hashAndBound(source) {
		for await (const raw of source) {
			if (input.signal?.aborted) throw input.signal.reason ?? new Error('Validation source was aborted');
			const chunk = Buffer.from(raw as Buffer | Uint8Array | string);
			bytesWritten += chunk.length;
			if (bytesWritten > totalBytes || bytesWritten > input.physicalByteLimit) throw new AppError(500, 'Completed source exceeds declared size', 'SIZE_MISMATCH');
			for (let offset = 0; offset < chunk.length;) {
				const take = Math.min(SOURCE_IDENTITY_BLOCK_SIZE_BYTES - blockBytes, chunk.length - offset);
				blockHash.update(chunk.subarray(offset, offset + take));
				blockBytes += take;
				offset += take;
				if (blockBytes === SOURCE_IDENTITY_BLOCK_SIZE_BYTES) finishBlock();
			}
			input.onBytes?.(chunk.length);
			yield chunk;
		}
	}, input.destination, ...(input.signal ? [{ signal: input.signal }] : []));
	if (bytesWritten !== totalBytes) throw new AppError(500, `Completed source size mismatch: expected ${totalBytes}, got ${bytesWritten}`, 'SIZE_MISMATCH');
	if (blockBytes > 0) finishBlock();
	if (actual.length !== blocks || sourceIdentityRoot(totalBytes, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, actual) !== input.sourceIdentity) {
		throw badRequest('Completed object source identity root mismatch');
	}
	return { bytesWritten };
}
