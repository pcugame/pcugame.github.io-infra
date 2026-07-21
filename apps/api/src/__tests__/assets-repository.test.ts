import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createAssetsRepository } from '../modules/assets/repository.js';

describe('assets repository', () => {
	it('clears a poster only while it still references the deleted asset', async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const repository = createAssetsRepository({
			project: { updateMany },
		} as unknown as PrismaClient);

		await repository.clearPosterIfMatches(7, 42);

		expect(updateMany).toHaveBeenCalledWith({
			where: { id: 7, posterAssetId: 42 },
			data: { posterAssetId: null },
		});
	});
});
