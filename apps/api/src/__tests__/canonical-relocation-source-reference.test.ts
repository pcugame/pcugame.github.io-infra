import { describe, expect, it, vi } from 'vitest';
import { collectObjectReferences, createObjectReferenceIndex } from '../modules/orphan/reference-resolver.js';

describe('Phase 1 correction source retention', () => {
	it('retains relocation sources after upload intents commit, including later overlapping prefix cleanup', async () => {
		const query = vi.fn().mockResolvedValue([{ id: 'committed-relocation', bucket: 'public', key: 'legacy/manual.txt' }]);
		const inventory = await collectObjectReferences({
			asset: { findMany: vi.fn().mockResolvedValue([]) }, exhibition: { findMany: vi.fn().mockResolvedValue([]) },
			project: { findMany: vi.fn().mockResolvedValue([]) }, gameUploadSession: { findMany: vi.fn().mockResolvedValue([]) },
			uploadIntent: { findMany: vi.fn().mockResolvedValue([]) }, $queryRaw: query,
		} as never, { publicBucket: 'public', protectedBucket: 'protected' }, { error: vi.fn() });
		expect(query).toHaveBeenCalledOnce();
		expect(inventory.references).toContainEqual({ bucket: 'public', targetKind: 'EXACT', key: 'legacy/manual.txt',
			source: 'canonical-relocation:committed-relocation:retained-source' });
		expect(createObjectReferenceIndex(inventory).referencesTarget({ bucket: 'public', targetKind: 'PREFIX', key: 'legacy/' })).toBe(true);
	});
});
