export const SOURCE_IDENTITY_ALGORITHM = 'SHA256_BLOCK_MANIFEST_V1' as const;
export const SOURCE_IDENTITY_BLOCK_SIZE_BYTES = 1_048_576;

const SOURCE_IDENTITY_PREFIX = 'PCU-UPLOAD-SOURCE-V1\0';
const encoder = new TextEncoder();

export interface SourceFileIdentity {
	sourceIdentityAlgorithm: typeof SOURCE_IDENTITY_ALGORITHM;
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: typeof SOURCE_IDENTITY_BLOCK_SIZE_BYTES;
	sourceIdentityBlockDigests: string[];
}

export interface ChunkReadableFile {
	size: number;
	slice(start?: number, end?: number): Pick<Blob, 'arrayBuffer'>;
}

export interface ComputeFileIdentityCoreOptions {
	digest?: (data: BufferSource) => Promise<ArrayBuffer>;
	onProgress?: (completedBlocks: number, totalBlocks: number) => void;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function uint64Bytes(value: number): Uint8Array {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
	return bytes;
}

function uint32Bytes(value: number): Uint8Array {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value, false);
	return bytes;
}

function buildManifest(
	totalBytes: number,
	blockDigests: Uint8Array[],
): Uint8Array {
	const prefix = encoder.encode(SOURCE_IDENTITY_PREFIX);
	const manifest = new Uint8Array(
		prefix.length + 8 + 4 + 4 + blockDigests.length * 32,
	);
	let offset = 0;
	manifest.set(prefix, offset);
	offset += prefix.length;
	manifest.set(uint64Bytes(totalBytes), offset);
	offset += 8;
	manifest.set(uint32Bytes(SOURCE_IDENTITY_BLOCK_SIZE_BYTES), offset);
	offset += 4;
	manifest.set(uint32Bytes(blockDigests.length), offset);
	offset += 4;
	for (const digest of blockDigests) {
		manifest.set(digest, offset);
		offset += digest.length;
	}
	return manifest;
}

/**
 * Hashes a file via bounded-size slices. This is deliberately separate from
 * the Worker wrapper so the byte-level contract can be tested without a DOM
 * Worker implementation.
 */
export async function computeFileIdentityCore(
	file: ChunkReadableFile,
	options: ComputeFileIdentityCoreOptions = {},
): Promise<SourceFileIdentity> {
	if (!Number.isSafeInteger(file.size) || file.size < 0) {
		throw new Error('파일 크기를 안전하게 확인할 수 없습니다.');
	}
	const digest = options.digest ?? ((data: BufferSource) => crypto.subtle.digest('SHA-256', data));
	const blockCount = Math.ceil(file.size / SOURCE_IDENTITY_BLOCK_SIZE_BYTES);
	if (blockCount > 0xffffffff) {
		throw new Error('파일이 identity manifest 한도를 초과합니다.');
	}

	const blockDigests: Uint8Array[] = [];
	for (let index = 0; index < blockCount; index++) {
		const start = index * SOURCE_IDENTITY_BLOCK_SIZE_BYTES;
		const end = Math.min(start + SOURCE_IDENTITY_BLOCK_SIZE_BYTES, file.size);
		const data = await file.slice(start, end).arrayBuffer();
		const blockDigest = new Uint8Array(await digest(data));
		if (blockDigest.byteLength !== 32) {
			throw new Error('SHA-256 digest 길이가 올바르지 않습니다.');
		}
		blockDigests.push(blockDigest);
		options.onProgress?.(index + 1, blockCount);
	}

	const manifest = buildManifest(file.size, blockDigests);
	const manifestBuffer = new ArrayBuffer(manifest.byteLength);
	new Uint8Array(manifestBuffer).set(manifest);
	const rootDigest = new Uint8Array(await digest(manifestBuffer));
	if (rootDigest.byteLength !== 32) {
		throw new Error('SHA-256 root digest 길이가 올바르지 않습니다.');
	}
	return {
		sourceIdentityAlgorithm: SOURCE_IDENTITY_ALGORITHM,
		sourceIdentity: bytesToHex(rootDigest),
		sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		sourceIdentityBlockDigests: blockDigests.map(bytesToHex),
	};
}
