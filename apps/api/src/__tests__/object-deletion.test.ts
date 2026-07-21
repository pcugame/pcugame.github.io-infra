import { describe, expect, it, vi } from 'vitest';
import { createObjectDeletionCoordinator } from '../application/object-deletion.js';

describe('object deletion coordinator', () => {
	it('persists a retryable orphan when object storage deletion fails', async () => {
		const deleteObject = vi.fn().mockRejectedValue(new Error('storage unavailable'));
		const record = vi.fn().mockResolvedValue(undefined);
		const logError = vi.fn();
		const coordinator = createObjectDeletionCoordinator({
			storage: { delete: deleteObject, listKeys: vi.fn() },
			orphans: { record },
			logger: { error: logError },
		});

		await expect(coordinator.deleteOrQueue(
			'protected',
			'games/old.zip',
			'game-replaced',
			{ projectId: 7 },
		)).resolves.toBeUndefined();
		expect(record).toHaveBeenCalledWith('protected', 'games/old.zip', 'game-replaced');
		expect(logError).toHaveBeenCalledWith(
			expect.objectContaining({
				bucket: 'protected',
				storageKey: 'games/old.zip',
				projectId: 7,
			}),
			'Object delete failed — queuing for orphan reaper',
		);
	});

	it('deletes every key in a prefix and queues only failed keys', async () => {
		const deleteObject = vi.fn(async (_bucket: string, key: string) => {
			if (key.endsWith('2.js')) throw new Error('transient');
		});
		const record = vi.fn().mockResolvedValue(undefined);
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: deleteObject,
				listKeys: vi.fn().mockResolvedValue(['site/1.js', 'site/2.js', 'site/3.js']),
			},
			orphans: { record },
			logger: { error: vi.fn() },
			deleteConcurrency: 2,
		});

		await expect(coordinator.deletePrefixOrQueue('public', 'site/', 'deployment-delete'))
			.resolves.toBe(3);
		expect(deleteObject).toHaveBeenCalledTimes(3);
		expect(record).toHaveBeenCalledOnce();
		expect(record).toHaveBeenCalledWith('public', 'site/2.js', 'deployment-delete');
	});
});
