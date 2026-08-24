import { describe, expect, it, vi } from 'vitest';

import { collectObjectReferences, createObjectReferenceIndex } from '../modules/orphan/reference-resolver.js';

const deployment = '11111111-1111-4111-8111-111111111111';

function clientForActiveWebgl(objectKey: string) {
	return {
		asset: { findMany: vi.fn().mockResolvedValue([]) },
		project: { findMany: vi.fn().mockResolvedValue([]) },
		assetUploadSession: { findMany: vi.fn().mockResolvedValue([
			{ id: 'active', bucket: 'protected', objectKey },
		]) },
		uploadIntent: { findMany: vi.fn().mockResolvedValue([]) },
	};
}

describe('active WebGL prefix reference fence (#29)', () => {
	it('keeps an active canonical WebGL source upload protected from reaping', async () => {
		const inventory = await collectObjectReferences(
			clientForActiveWebgl(`webgl/7/${deployment}/source.zip`) as never,
			{ publicBucket: 'public', protectedBucket: 'protected' }, { error: vi.fn() },
		);
		expect(inventory.references).toContainEqual({
			bucket: 'protected', targetKind: 'EXACT', key: `webgl/7/${deployment}/source.zip`,
			source: 'upload-session:active:active',
		});
		const index = createObjectReferenceIndex(inventory);
		expect(index.referencesTarget({
			bucket: 'protected', targetKind: 'EXACT', key: `webgl/7/${deployment}/source.zip`,
		})).toBe(true);
	});

	it('uses the session object identity directly without reconstructing a public generation', async () => {
		const logger = { error: vi.fn() };
		const inventory = await collectObjectReferences(
			clientForActiveWebgl('webgl/7/not-a-deployment/source.zip') as never,
			{ publicBucket: 'public', protectedBucket: 'protected' }, logger,
		);
		expect(inventory.unsafeBuckets).toEqual(new Set());
		expect(createObjectReferenceIndex(inventory).referencesTarget({
			bucket: 'protected', targetKind: 'EXACT', key: 'webgl/7/not-a-deployment/source.zip',
		})).toBe(true);
		expect(logger.error).not.toHaveBeenCalled();
	});
});
