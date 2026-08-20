import { describe, expect, it } from 'vitest';

import {
	computeFileIdentityCore,
	SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
} from '../lib/upload/file-identity-core';

class SliceOnlyFile {
	readonly size: number;
	readonly slices: Array<[number, number]> = [];

	private readonly bytes: Uint8Array;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
		this.size = bytes.byteLength;
	}

	// A full-file arrayBuffer is intentionally unavailable. The production core
	// must only ask the object returned by File.slice() for bytes.
	arrayBuffer(): Promise<ArrayBuffer> {
		throw new Error('full file arrayBuffer must not be called');
	}

	slice(start = 0, end = this.size) {
		this.slices.push([start, end]);
		const selected = this.bytes.slice(start, end);
		return {
			arrayBuffer: async () => selected.buffer.slice(
				selected.byteOffset,
				selected.byteOffset + selected.byteLength,
			),
		};
	}
}

describe('computeFileIdentityCore', () => {
	it('uses the SHA256_BLOCK_MANIFEST_V1 canonical root format', async () => {
		const file = new SliceOnlyFile(new TextEncoder().encode('abc'));

		const identity = await computeFileIdentityCore(file);

		expect(identity.sourceIdentityBlockDigests).toEqual([
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		]);
		expect(identity.sourceIdentity).toBe(
			'c30df0b0d82a2cf7f1c3796975040026caf737d90a97e5edb79932f1fc0e9e2e',
		);
	});

	it('hashes bounded File slices rather than a full-file ArrayBuffer', async () => {
		const bytes = new Uint8Array(SOURCE_IDENTITY_BLOCK_SIZE_BYTES + 3);
		bytes.fill(0x61, 0, SOURCE_IDENTITY_BLOCK_SIZE_BYTES);
		bytes.fill(0x62, SOURCE_IDENTITY_BLOCK_SIZE_BYTES);
		const file = new SliceOnlyFile(bytes);

		const identity = await computeFileIdentityCore(file, {
			digest: async (data) => {
				const firstByte = new Uint8Array(data as ArrayBuffer)[0] ?? 0;
				return new Uint8Array(32).fill(firstByte).buffer;
			},
		});

		expect(file.slices).toEqual([
			[0, SOURCE_IDENTITY_BLOCK_SIZE_BYTES],
			[SOURCE_IDENTITY_BLOCK_SIZE_BYTES, SOURCE_IDENTITY_BLOCK_SIZE_BYTES + 3],
		]);
		expect(identity.sourceIdentityBlockDigests).toEqual([
			'61'.repeat(32),
			'62'.repeat(32),
		]);
		// The deterministic digest returns the first canonical-manifest byte for
		// the root; this also verifies a separate root digest is produced.
		expect(identity.sourceIdentity).toBe('50'.repeat(32));
	});
});
