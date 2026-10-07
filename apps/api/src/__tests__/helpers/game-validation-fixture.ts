import { createHash } from 'node:crypto';
import { sourceIdentityRoot, SOURCE_IDENTITY_BLOCK_SIZE_BYTES } from '../../modules/admin/game-upload/source-identity.js';
import type { AssetUploadSessionRecord } from '../../modules/asset-upload/ports.js';

/** One stored entry, with real ZIP headers and CRC, for worker boundary tests. */
export function gameZip(): Buffer {
	const name = Buffer.from('game.exe');
	const data = Buffer.from('game contents');
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	crc = (crc ^ 0xffffffff) >>> 0;
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
	local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(name.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
	central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(name.length, 28);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + name.length, 12);
	end.writeUInt32LE(local.length + name.length + data.length, 16);
	return Buffer.concat([local, name, data, central, name, end]);
}

export function validationSession(bytes = gameZip(), overrides: Partial<AssetUploadSessionRecord> = {}): AssetUploadSessionRecord {
	const digests: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += SOURCE_IDENTITY_BLOCK_SIZE_BYTES) {
		digests.push(createHash('sha256').update(bytes.subarray(offset, offset + SOURCE_IDENTITY_BLOCK_SIZE_BYTES)).digest('hex'));
	}
	return {
		id: 'game-validation', projectId: 7, exhibitionId: null, userId: 9, kind: 'GAME', state: 'VERIFYING',
		originalName: 'game.zip', declaredMimeType: 'application/zip', totalBytes: BigInt(bytes.length),
		partSizeBytes: bytes.length, totalParts: 1, bucket: 'protected', objectKey: 'protected/uploads/game-validation/source',
		uploadId: null, generation: 1, sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
		sourceIdentity: sourceIdentityRoot(bytes.length, SOURCE_IDENTITY_BLOCK_SIZE_BYTES, digests),
		sourceIdentityBlockSizeBytes: SOURCE_IDENTITY_BLOCK_SIZE_BYTES,
		sourceIdentityBlockManifest: Buffer.concat(digests.map((digest) => Buffer.from(digest, 'hex'))).toString('base64'),
		completionLeaseToken: null, completionLeaseUntil: null, completionResult: null,
		validationLeaseToken: 'claim', validationLeaseUntil: new Date(Date.now() + 120_000), validationAttemptCount: 1,
		expectedTargetAssetId: null, expectedTargetAssetUpdatedAt: null,
		resultAssetId: null, resultRepresentationId: null, expiresAt: new Date(Date.now() + 120_000), ...overrides,
	};
}
