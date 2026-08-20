import { describe, expect, it, vi } from 'vitest';

import { collectObjectReferences, createObjectReferenceIndex } from '../modules/orphan/reference-resolver.js';

const deployment = '11111111-1111-4111-8111-111111111111';

function clientForActiveWebgl(s3Key: string) {
	return {
		asset: { findMany: vi.fn().mockResolvedValue([]) },
		exhibition: { findMany: vi.fn().mockResolvedValue([]) },
		project: { findMany: vi.fn().mockResolvedValue([]) },
		gameUploadSession: {
			findMany: vi.fn(async (query: { where: { status: unknown } }) =>
				query.where.status === 'COMPLETED'
					? []
					: [{ id: 'active', s3Key, uploadKind: 'WEBGL', projectId: 7 }]),
		},
		uploadIntent: { findMany: vi.fn().mockResolvedValue([]) },
	};
}

function clientForVerifyingUpload(input: {
	uploadKind: 'GAME' | 'WEBGL';
	s3Key: string | null;
	storageKey: string | null;
}) {
	return {
		asset: { findMany: vi.fn().mockResolvedValue([]) },
		exhibition: { findMany: vi.fn().mockResolvedValue([]) },
		project: { findMany: vi.fn().mockResolvedValue([]) },
		gameUploadSession: {
			findMany: vi.fn(async (query: { where: { status: unknown } }) =>
				query.where.status === 'COMPLETED'
					? []
					: [{
						id: 'verifying', projectId: 7, status: 'VERIFYING',
						uploadKind: input.uploadKind, s3Key: input.s3Key, storageKey: input.storageKey,
					}]),
		},
		uploadIntent: { findMany: vi.fn().mockResolvedValue([]) },
	};
}

describe('active WebGL prefix reference fence (#29)', () => {
	it('publishes an active WebGL site PREFIX reference that blocks an overlapping reaper claim', async () => {
		const inventory = await collectObjectReferences(
			clientForActiveWebgl(`webgl/7/${deployment}/source.zip`) as never,
			{ publicBucket: 'public', protectedBucket: 'protected' }, { error: vi.fn() },
		);
		expect(inventory.references).toContainEqual({
			bucket: 'public', targetKind: 'PREFIX', key: `webgl/7/${deployment}/site/`,
			source: 'upload-session:active:webgl-site',
		});
		const index = createObjectReferenceIndex(inventory);
		expect(index.referencesTarget({
			bucket: 'public', targetKind: 'PREFIX', key: `webgl/7/${deployment}/site/`,
		})).toBe(true);
	});

	it('fails closed for malformed active WebGL identity in both buckets', async () => {
		const logger = { error: vi.fn() };
		const inventory = await collectObjectReferences(
			clientForActiveWebgl('webgl/7/not-a-deployment/source.zip') as never,
			{ publicBucket: 'public', protectedBucket: 'protected' }, logger,
		);
		expect(inventory.unsafeBuckets).toEqual(new Set(['protected', 'public']));
		expect(createObjectReferenceIndex(inventory).referencesTarget({
			bucket: 'public', targetKind: 'PREFIX', key: 'unrelated/',
		})).toBe(true);
		expect(logger.error).toHaveBeenCalledOnce();
	});

	it('keeps a VERIFYING direct GAME protected source alive through the asset-commit gap', async () => {
		const inventory = await collectObjectReferences(
			clientForVerifyingUpload({
				uploadKind: 'GAME',
				s3Key: 'games/7/generation-1.zip',
				storageKey: 'games/7/generation-1.zip',
			}) as never,
			{ publicBucket: 'public', protectedBucket: 'protected' }, { error: vi.fn() },
		);

		expect(inventory.references).toContainEqual({
			bucket: 'protected',
			targetKind: 'EXACT',
			key: 'games/7/generation-1.zip',
			source: 'upload-session:verifying:active-source',
		});
		expect(createObjectReferenceIndex(inventory).referencesTarget({
			bucket: 'protected', targetKind: 'EXACT', key: 'games/7/generation-1.zip',
		})).toBe(true);
	});

	it('fences both protected aliases and only a WebGL generation prefix while VERIFYING', async () => {
		const newDeployment = '22222222-2222-4222-8222-222222222222';
		const oldDeployment = '33333333-3333-4333-8333-333333333333';
		const inventory = await collectObjectReferences(
			clientForVerifyingUpload({
				uploadKind: 'WEBGL',
				s3Key: `webgl/7/${newDeployment}/source.zip`,
				storageKey: `webgl/7/${oldDeployment}/source.zip`,
			}) as never,
			{ publicBucket: 'public', protectedBucket: 'protected' }, { error: vi.fn() },
		);

		expect(inventory.references).toEqual(expect.arrayContaining([
			expect.objectContaining({ bucket: 'protected', key: `webgl/7/${newDeployment}/source.zip` }),
			expect.objectContaining({ bucket: 'protected', key: `webgl/7/${oldDeployment}/source.zip` }),
			expect.objectContaining({
				bucket: 'public', targetKind: 'PREFIX', key: `webgl/7/${newDeployment}/site/`,
				source: 'upload-session:verifying:webgl-site',
			}),
			expect.objectContaining({
				bucket: 'public', targetKind: 'PREFIX', key: `webgl/7/${oldDeployment}/site/`,
				source: 'upload-session:verifying:webgl-site',
			}),
		]));
		// A verification fence never synthesizes the project READY pointer.
		expect(inventory.references.some((reference) => reference.source === 'project:7:webgl-site')).toBe(false);
	});
});
