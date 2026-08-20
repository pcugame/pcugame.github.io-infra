import { createHash } from 'node:crypto';
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
		throw conflict('This legacy upload session cannot be resumed; start a new upload', {
			reason: 'LEGACY_UPLOAD_SESSION',
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

export function assertChunkMatchesManifest(input: {
	buffer: Buffer;
	chunkIndex: number;
	chunkSizeBytes: number;
	manifest: Uint8Array;
}): string {
	const { buffer, chunkIndex, chunkSizeBytes, manifest } = input;
	const firstBlock = (chunkIndex * chunkSizeBytes) / SOURCE_IDENTITY_BLOCK_SIZE_BYTES;
	if (!Number.isInteger(firstBlock) || manifest.length % 32 !== 0) {
		throw new Error('Invalid persisted source identity alignment');
	}
	for (let offset = 0, block = firstBlock; offset < buffer.length; offset += SOURCE_IDENTITY_BLOCK_SIZE_BYTES, block += 1) {
		const actual = createHash('sha256').update(buffer.subarray(offset, Math.min(offset + SOURCE_IDENTITY_BLOCK_SIZE_BYTES, buffer.length))).digest();
		const expected = manifest.subarray(block * 32, block * 32 + 32);
		if (expected.length !== 32 || !actual.equals(expected)) {
			throw conflict('Chunk content does not match this upload session', { reason: 'CHUNK_CONTENT_MISMATCH' });
		}
	}
	return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Recomputes a completed direct-upload identity one fixed-size block at a
 * time. The largest resident object buffer is 1 MiB; the claim is checked on
 * both sides of every internal storage read.
 */
export async function validateCompletedSourceIdentity(input: {
	totalBytes: bigint;
	sourceIdentityAlgorithm?: string | null;
	sourceIdentity?: string | null;
	sourceIdentityBlockSizeBytes?: number | null;
	sourceIdentityBlockManifest?: Uint8Array | null;
	readRange(start: number, end: number): Promise<Buffer>;
	assertClaimOwned?: () => Promise<void>;
}): Promise<void> {
	assertSessionHasSourceIdentity(input);
	const totalBytes = Number(input.totalBytes);
	if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
		throw new Error('Persisted upload size is outside the safe integer range');
	}
	const blockCount = Math.ceil(totalBytes / SOURCE_IDENTITY_BLOCK_SIZE_BYTES);
	if (input.sourceIdentityBlockManifest.length !== blockCount * 32) {
		throw new Error('Persisted source identity manifest length is invalid');
	}
	const manifest = Buffer.from(input.sourceIdentityBlockManifest);
	const actualDigests: string[] = [];
	for (let block = 0; block < blockCount; block += 1) {
		await input.assertClaimOwned?.();
		const start = block * SOURCE_IDENTITY_BLOCK_SIZE_BYTES;
		const end = Math.min(totalBytes, start + SOURCE_IDENTITY_BLOCK_SIZE_BYTES) - 1;
		const bytes = await input.readRange(start, end);
		await input.assertClaimOwned?.();
		const expectedLength = end - start + 1;
		if (bytes.length !== expectedLength) {
			throw new AppError(
				500,
				`Completed source block ${block} size mismatch`,
				'SIZE_MISMATCH',
			);
		}
		const digest = createHash('sha256').update(bytes).digest();
		const expected = manifest.subarray(block * 32, block * 32 + 32);
		if (!digest.equals(expected)) {
			throw badRequest('Completed object does not match the upload source identity');
		}
		actualDigests.push(digest.toString('hex'));
	}
	const actualRoot = sourceIdentityRoot(
		totalBytes,
		SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		actualDigests,
	);
	if (actualRoot !== input.sourceIdentity) {
		throw badRequest('Completed object source identity root mismatch');
	}
}
