import { describe, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { AssetUploadRepository } from '../modules/asset-upload/ports.js';
import { createAssetUploadRepository } from '../modules/asset-upload/repository.js';

vi.mock('../modules/admin/project-access.service.js', () => ({
	assertProjectUploadWriteAccessInTransaction: vi.fn(async () => undefined),
}));

function harness(itemState = 'FAILED', sessionState = 'REJECTED') {
	const item = {
		id: 'item', kind: 'GAME', clientToken: 't'.repeat(32), state: itemState,
		projectSubmission: { projectId: 7, actorId: 11, state: 'PENDING' },
		uploadSession: { id: 'old-session', state: sessionState },
	};
	const tx = {
		project: { findUniqueOrThrow: vi.fn(async () => ({ status: 'DRAFT' })) },
		projectSubmissionItem: { findUnique: vi.fn(async () => item), update: vi.fn(async () => ({})) },
		asset: { findFirst: vi.fn(async () => null) },
		assetUploadSession: {
			update: vi.fn(async () => ({})),
			create: vi.fn(async ({ data }) => data),
		},
	};
	const transaction = vi.fn(async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(tx as unknown as Prisma.TransactionClient));
	const repository = createAssetUploadRepository({ $transaction: transaction } as unknown as PrismaClient);
	const input: Parameters<AssetUploadRepository['createAllocating']>[0] = {
		id: 'new-session', projectId: 7, exhibitionId: null, userId: 11, kind: 'GAME', originalName: 'game.zip',
		declaredMimeType: 'application/zip', totalBytes: 10n, partSizeBytes: 10, totalParts: 1,
		bucket: 'protected', objectKey: 'new-source.zip', generation: 1,
		sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1', sourceIdentity: 'a'.repeat(64),
		sourceIdentityBlockSizeBytes: 1_048_576, sourceIdentityBlockManifest: 'e30=',
		expiresAt: new Date(Date.now() + 60_000), submissionItemId: 'item', submissionClientToken: item.clientToken,
	};
	return { item, tx, transaction, repository, input };
}

describe('submission upload retries', () => {
	it.each([['FAILED', 'REJECTED'], ['CANCELLED', 'CANCELLED'], ['CANCELLED', 'EXPIRED']])(
		'rebinds %s / %s in one serializable transaction', async (itemState, sessionState) => {
			const h = harness(itemState, sessionState);
			await expect(h.repository.createAllocating(h.input)).resolves.toMatchObject({ id: 'new-session', submissionItemId: 'item' });
			expect(h.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), { isolationLevel: 'Serializable' });
			expect(h.tx.assetUploadSession.update).toHaveBeenCalledExactlyOnceWith({ where: { id: 'old-session' }, data: { submissionItemId: null } });
			expect(h.tx.projectSubmissionItem.update).toHaveBeenCalledWith({ where: { id: 'item' }, data: expect.objectContaining({ state: 'EXPECTED', boundGeneration: null, failureReason: null }) });
			expect(h.tx.assetUploadSession.update.mock.invocationCallOrder[0]).toBeLessThan(h.tx.projectSubmissionItem.update.mock.invocationCallOrder[0]!);
			expect(h.tx.projectSubmissionItem.update.mock.invocationCallOrder[0]).toBeLessThan(h.tx.assetUploadSession.create.mock.invocationCallOrder[0]!);
		},
	);

	it.each(['ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING', 'READY'])('never detaches a %s session', async (state) => {
		const h = harness('FAILED', state);
		await expect(h.repository.createAllocating(h.input)).rejects.toThrow('PROJECT_SUBMISSION_ITEM_MISMATCH');
		expect(h.tx.assetUploadSession.update).not.toHaveBeenCalled();
		expect(h.tx.assetUploadSession.create).not.toHaveBeenCalled();
	});

	it.each(['actor', 'project', 'kind', 'token', 'finalizing'])('rejects a mismatched %s before detaching the previous session', async (mismatch) => {
		const h = harness();
		if (mismatch === 'actor') h.item.projectSubmission.actorId = 12;
		if (mismatch === 'project') h.item.projectSubmission.projectId = 8;
		if (mismatch === 'kind') h.item.kind = 'VIDEO';
		if (mismatch === 'token') h.item.clientToken = 'wrong';
		if (mismatch === 'finalizing') h.item.projectSubmission.state = 'FINALIZING';
		await expect(h.repository.createAllocating(h.input)).rejects.toThrow('PROJECT_SUBMISSION_ITEM_MISMATCH');
		expect(h.tx.assetUploadSession.update).not.toHaveBeenCalled();
	});
});
