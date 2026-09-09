import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createS3Client } from '../lib/s3.js';
import { createMultipartPartPresigner, createProtectedDownloadPresigner } from '../lib/storage.js';
import {
	assertCompletionManifestMatchesGarage,
	assertMultipartPartCount,
	MAX_MULTIPART_PARTS,
	validateStoredMultipartParts,
	validateSubmittedCompletionParts,
} from '../modules/admin/game-upload/direct-multipart.js';
import {
	materializeAndValidateCompletedSource,
	SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
	sourceIdentityRoot,
	validateSourceIdentity,
} from '../modules/admin/game-upload/source-identity.js';

function identity(bytes: Buffer) {
	const digests: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += SOURCE_IDENTITY_BLOCK_SIZE_BYTES) {
		digests.push(createHash('sha256').update(bytes.subarray(offset, offset + SOURCE_IDENTITY_BLOCK_SIZE_BYTES)).digest('hex'));
	}
	return {
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1' as const,
		sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		sourceIdentityBlockDigests: digests,
		sourceIdentity: sourceIdentityRoot(bytes.length, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, digests),
		sourceIdentityBlockManifest: Buffer.concat(digests.map((digest) => Buffer.from(digest, 'hex'))),
	};
}

describe('direct multipart GAME foundation', () => {
	it('requires Garage ListParts sizes and ETags, not the client completion manifest', () => {
		const submitted = validateSubmittedCompletionParts({ generation: 7, parts: [
			{ partNumber: 2, etag: '"part-two"', sizeBytes: 2 },
			{ partNumber: 1, etag: 'part-one', sizeBytes: 5 },
		] }, 2);
		const stored = validateStoredMultipartParts({
			parts: [{ partNumber: 1, etag: '"part-one"', sizeBytes: 5 }, { partNumber: 2, etag: 'part-two', sizeBytes: 2 }],
			totalBytes: 7n,
			partSizeBytes: 5,
			totalParts: 2,
		});
		expect(() => assertCompletionManifestMatchesGarage(submitted, stored)).not.toThrow();
		expect(() => assertCompletionManifestMatchesGarage(submitted, [{ ...stored[0]!, etag: 'different' }, stored[1]!])).toThrow(/does not match Garage ListParts/);
		expect(() => validateStoredMultipartParts({ parts: [{ partNumber: 1, etag: 'x', sizeBytes: 4 }], totalBytes: 7n, partSizeBytes: 5, totalParts: 2 })).toThrow(/Garage contains/);
	});

	it('enforces the S3 multipart hard boundary before allocation', () => {
		expect(() => assertMultipartPartCount(MAX_MULTIPART_PARTS)).not.toThrow();
		expect(() => assertMultipartPartCount(MAX_MULTIPART_PARTS + 1)).toThrow(/10000/);
	});

	it('issues a browser UploadPart capability without giving the control path a byte relay', async () => {
		const client = createS3Client({
			S3_ENDPOINT: 'https://upload.example.test/s3',
			S3_REGION: 'garage',
			S3_ACCESS_KEY_ID: 'fixture-access-key',
			S3_SECRET_ACCESS_KEY: 'fixture-secret-key',
			S3_FORCE_PATH_STYLE: true,
		});
		const signer = createMultipartPartPresigner(client);
		const url = new URL(await signer.presignUploadPart(
			'protected', 'protected/uploads/session-1/generation-1', 'upload-1', 1, 60,
			'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
		));
		expect(url.origin).toBe('https://upload.example.test');
		expect(url.searchParams.get('partNumber')).toBe('1');
		expect(url.searchParams.get('uploadId')).toBe('upload-1');
		expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('x-amz-checksum-sha256');
		expect([...url.searchParams.keys()].some((key) => key.toLowerCase() === 'x-amz-checksum-sha256')).toBe(false);
		client.destroy();
	});

	it('issues only GetObject capabilities from the protected delivery client', async () => {
		const client = createS3Client({
			S3_ENDPOINT: 'https://download.example.test',
			S3_REGION: 'garage',
			S3_ACCESS_KEY_ID: 'fixture-access-key',
			S3_SECRET_ACCESS_KEY: 'fixture-secret-key',
			S3_FORCE_PATH_STYLE: true,
		});
		const signer = createProtectedDownloadPresigner(client, { defaultPresignTtlSec: 45 });
		expect(Object.keys(signer)).toEqual(['presign']);
		const url = new URL(await signer.presign('protected', 'objects/private game.zip', {
			responseContentDisposition: 'attachment; filename="game.zip"',
		}));
		expect(url.origin).toBe('https://download.example.test');
		expect(url.pathname).toBe('/protected/objects/private%20game.zip');
		expect(url.searchParams.get('X-Amz-Expires')).toBe('45');
		expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="game.zip"');
		client.destroy();
	});

	it('validates and materializes the source identity in one bounded stream pass', async () => {
		const source = Buffer.alloc(SOURCE_IDENTITY_BLOCK_SIZE_BYTES + 19, 0x5a);
		const proof = identity(source);
		expect(validateSourceIdentity(proof, source.length).identity).toBe(proof.sourceIdentity);
		const output: Buffer[] = [];
		await expect(materializeAndValidateCompletedSource({
			totalBytes: BigInt(source.length),
			...proof,
			source: Readable.from([source.subarray(0, 17), source.subarray(17)]),
			destination: new Writable({ write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); } }),
			physicalByteLimit: source.length,
		})).resolves.toEqual({ bytesWritten: source.length });
		expect(Buffer.concat(output)).toEqual(source);
	});

	it('rejects a completed object whose body no longer matches the session source identity', async () => {
		const expected = identity(Buffer.from('expected direct source'));
		await expect(materializeAndValidateCompletedSource({
			totalBytes: BigInt(Buffer.byteLength('expected direct source')),
			...expected,
			source: Readable.from([Buffer.from('tampered direct source')]),
			destination: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
			physicalByteLimit: 1024,
		})).rejects.toMatchObject({ statusCode: 400 });
	});
});
