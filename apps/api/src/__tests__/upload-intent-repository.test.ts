import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createUploadIntentRepository } from '../modules/upload-intent/repository.js';

function harness(state: 'PREPARED' | 'UPLOADED' | 'COMMITTED' | 'CLEANUP_QUEUED' | 'RESOLVED') {
	const existing = {
		id: 'existing-intent',
		state,
		purpose: 'backfill-image-rendition-card_480',
		ownerOperationId: null,
		ownerActorId: null,
		ownerProjectId: 7,
		ownerExhibitionId: null,
	};
	const create = vi.fn();
	const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
		...existing,
		...data,
	}));
	const tx = {
		$queryRaw: vi.fn(async () => []),
		uploadIntent: {
			findUnique: vi.fn(async () => existing),
			create,
			update,
		},
	};
	const client = {
		$transaction: vi.fn(async (operation) => operation(tx)),
	} as unknown as PrismaClient;
	return { repository: createUploadIntentRepository(client), create, update };
}

const data = {
	id: 'new-intent',
	bucket: 'public',
	storageKey: 'source.webp/__pcu_image_rendition__/v1/card-480.webp',
	purpose: 'backfill-image-rendition-card_480',
	ownerProjectId: 7,
	notBefore: new Date('2026-08-12T00:00:00.000Z'),
};

describe('deterministic-key upload intent preparation', () => {
	it.each(['PREPARED', 'UPLOADED', 'COMMITTED', 'CLEANUP_QUEUED'] as const)(
		'rejects an existing %s intent before immutable object PUT',
		async (state) => {
			const test = harness(state);
			await expect(test.repository.prepare(data)).rejects.toThrow(
				`Upload intent already owns object key in state ${state}`,
			);
			expect(test.create).not.toHaveBeenCalled();
			expect(test.update).not.toHaveBeenCalled();
		},
	);

	it('rearms only a resolved/missing attempt and returns the durable existing ID', async () => {
		const test = harness('RESOLVED');
		await expect(test.repository.prepare(data)).resolves.toMatchObject({
			id: 'existing-intent',
			state: 'PREPARED',
		});
		expect(test.update).toHaveBeenCalledWith({
			where: { id: 'existing-intent' },
			data: expect.objectContaining({
				state: 'PREPARED',
				purpose: data.purpose,
				ownerProjectId: 7,
			}),
		});
	});
});
