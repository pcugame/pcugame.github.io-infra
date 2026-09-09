import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { validateMaterialContent, validateMaterialSource } from '../modules/asset-upload/material-validation.js';
import { createGameUploadValidationWorker } from '../modules/asset-upload/validation-worker.service.js';
import { sourceIdentityRoot } from '../modules/admin/game-upload/source-identity.js';
import { resolveDownloadRepresentation } from '../modules/assets/download-resolver.js';
import { authorizeAssetDelivery } from '../modules/assets/delivery-policy.js';
import type { AssetUploadRepository, AssetUploadSessionRecord } from '../modules/asset-upload/ports.js';

function session(bytes: Buffer): AssetUploadSessionRecord {
	const digest = createHash('sha256').update(bytes).digest('hex');
	return { id: 'material', projectId: 1, kind: 'DOCUMENT', generation: 1, totalBytes: BigInt(bytes.length), originalName: 'manual.txt',
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentityBlockSizeBytes: 1_048_576,
		sourceIdentity: sourceIdentityRoot(bytes.length, 1_048_576, [digest]),
		sourceIdentityBlockManifest: Buffer.from(digest, 'hex').toString('base64'), validationAttemptCount: 1,
	} as unknown as AssetUploadSessionRecord;
}

describe('project materials', () => {
	it('validates text encodings and rejects binary masquerading as text or PDF', async () => {
		await expect(validateMaterialContent('DOCUMENT', '설명서.md', Buffer.from('# 게임 설명서'))).resolves.toBe('text/markdown');
		await expect(validateMaterialContent('DOCUMENT', '설명서.txt', Buffer.from('bec8b3e7', 'hex'))).resolves.toBe('text/plain');
		await expect(validateMaterialContent('DOCUMENT', 'pdf.txt', Buffer.from('%PDF-1.7\nASCII PDF content'))).rejects.toThrow('Invalid');
		await expect(validateMaterialContent('DOCUMENT', 'bad.txt', Buffer.from([0, 1, 2]))).rejects.toThrow('Invalid');
		await expect(validateMaterialContent('DOCUMENT', 'bad.pdf', Buffer.from('plain text content'))).rejects.toThrow('Invalid');
		await expect(validateMaterialContent('DOCUMENT', 'bad.docx', Buffer.from('%PDF-1.7\nhello'))).rejects.toThrow('Invalid');
		await expect(validateMaterialContent('DOCUMENT', 'script.exe', Buffer.from('MZ'))).rejects.toThrow('extension');
		await expect(validateMaterialContent('ATTACHMENT', 'supplement.bin', Buffer.from([0, 1, 2]))).resolves.toBe('application/octet-stream');
	});
	it('verifies the exact source bytes before making a document READY', async () => {
		const bytes = Buffer.from('project manual'); const item = session(bytes);
		await expect(validateMaterialSource({ session: item, source: { body: Readable.from(bytes), size: bytes.length } })).resolves.toEqual({ mimeType: 'text/plain', checksum: createHash('sha256').update(bytes).digest('hex') });
		await expect(validateMaterialSource({ session: item, source: { body: Readable.from(Buffer.from('changed manual')), size: bytes.length } })).rejects.toThrow('source identity');
	});
	it('shares the worker lease and records atomic completion only after verification', async () => {
		const bytes = Buffer.from('project manual'); const item = session(bytes);
		const repository = { claimVerifying: vi.fn(async (kind) => kind === 'DOCUMENT' ? [item] : []), renewValidation: vi.fn(async () => true), commitGameReady: vi.fn(async () => ({ assetId: 3, representationId: 'original' })), markRejected: vi.fn() } as unknown as AssetUploadRepository;
		const worker = createGameUploadValidationWorker({ repository, storage: { stream: async () => ({ body: Readable.from(bytes), size: bytes.length }) }, ids: { next: () => 'lease' }, tempRoot: '/tmp', tempDiskBudgetBytes: 1024, logger: { error: vi.fn() }, wakeDeletionWorker: vi.fn() });
		await expect(worker.runPass()).resolves.toEqual({ claimed: 1, ready: 1, rejected: 0, retried: 0 });
		expect(repository.commitGameReady).toHaveBeenCalledWith(expect.objectContaining({ session: item, token: 'lease', mimeType: 'text/plain', checksum: createHash('sha256').update(bytes).digest('hex') }));
	});
	it('permits public project downloads and refuses material playback', () => {
		const asset = { id: 1, kind: 'DOCUMENT', status: 'READY', storageKey: null, playbackStorageKey: null, playbackStatus: 'PENDING', project: { status: 'PUBLISHED', creatorId: 3, members: [] }, representations: [{ role: 'ORIGINAL', state: 'READY', bucket: 'protected', objectKey: 'manual' }] };
		expect(authorizeAssetDelivery({ action: 'DOWNLOAD_ORIGINAL', asset })).toBe(true);
		expect(resolveDownloadRepresentation(asset, 'original', 'protected')).toMatchObject({ objectKey: 'manual' });
		expect(() => resolveDownloadRepresentation(asset, 'playback', 'protected')).toThrow();
		expect(authorizeAssetDelivery({ action: 'DOWNLOAD_ORIGINAL', asset: { ...asset, project: { ...asset.project, status: 'DRAFT' } } })).toBe(false);
	});
});

import { processFileParts } from '../modules/admin/project/project-submit.service.js';
import { validateProjectUploadFile } from '../modules/admin/project/project-file-validation.js';
import type { UploadPipelinePort } from '../application/upload-ports.js';

describe('Phase 1 material multipart submission', () => {
	it('routes documents and attachments through original processing and enforces the combined limit', async () => {
		const processFile = vi.fn(async () => ({}));
		const pipeline = { processFile } as unknown as UploadPipelinePort;
		const files = [{ fieldname: 'documents[]', filename: 'manual.txt', tmpPath: '/tmp/manual' }, { fieldname: 'attachments[]', filename: 'source.dat', tmpPath: '/tmp/source' }];
		await processFileParts(files, pipeline);
		expect(processFile.mock.calls).toEqual([['/tmp/manual', 'DOCUMENT', 'manual.txt'], ['/tmp/source', 'ATTACHMENT', 'source.dat']]);
		processFile.mockClear();
		await expect(processFileParts([...files, ...files, ...files], pipeline)).rejects.toThrow('at most 5');
		expect(processFile).not.toHaveBeenCalled();
	});
	it('validates actual multipart content with the original extension', async () => {
		const bytes = Buffer.from('project manual');
		const fs = { stat: vi.fn(async () => ({ size: bytes.length })), readRange: vi.fn(async () => bytes) };
		await expect(validateProjectUploadFile(fs as never, '/tmp/manual', 'DOCUMENT', '설명서.txt')).resolves.toMatchObject({ mimeType: 'text/plain', ext: 'txt', sizeBytes: bytes.length });
		await expect(validateProjectUploadFile(fs as never, '/tmp/manual', 'DOCUMENT', 'spoof.pdf')).rejects.toThrow('Invalid');
	});
});
