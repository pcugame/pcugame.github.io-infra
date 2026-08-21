import type { DirectUploadSourceIdentity } from '../contracts';

export const SOURCE_IDENTITY_BLOCK_SIZE_BYTES = 1_048_576 as const;
const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
	const source = bytes instanceof Uint8Array ? Uint8Array.from(bytes).buffer : bytes;
	return new Uint8Array(await crypto.subtle.digest('SHA-256', source));
}

/** Browser-side source proof used before any direct UploadPart capability. */
export async function createFileSourceIdentity(file: File): Promise<DirectUploadSourceIdentity> {
	const digests: string[] = [];
	const digestBytes: Uint8Array[] = [];
	for (let offset = 0; offset < file.size; offset += SOURCE_IDENTITY_BLOCK_SIZE_BYTES) {
		const digest = await sha256(await file.slice(offset, offset + SOURCE_IDENTITY_BLOCK_SIZE_BYTES).arrayBuffer());
		digestBytes.push(digest);
		digests.push(hex(digest));
	}
	const header = new ArrayBuffer(16);
	const view = new DataView(header);
	view.setBigUint64(0, BigInt(file.size));
	view.setUint32(8, SOURCE_IDENTITY_BLOCK_SIZE_BYTES);
	view.setUint32(12, digestBytes.length);
	const prefix = encoder.encode('PCU-UPLOAD-SOURCE-V1\0');
	const manifest = new Uint8Array(digestBytes.length * 32);
	digestBytes.forEach((digest, index) => manifest.set(digest, index * 32));
	const rootInput = new Uint8Array(prefix.length + 16 + manifest.length);
	rootInput.set(prefix);
	rootInput.set(new Uint8Array(header), prefix.length);
	rootInput.set(manifest, prefix.length + 16);
	return {
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
		sourceIdentity: hex(await sha256(rootInput)),
		sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		sourceIdentityBlockDigests: digests,
	};
}
