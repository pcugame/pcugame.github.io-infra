import { describe, expect, it, vi } from 'vitest';
import {
	createObjectDeletionCoordinator,
	DurableObjectDeletionError,
} from '../application/object-deletion.js';

describe('object deletion coordinator', () => {
	it('does not write an orphan row when object storage deletion succeeds', async () => {
		const record = vi.fn().mockRejectedValue(new Error('queue must not be used'));
		const coordinator = createObjectDeletionCoordinator({
			storage: { delete: vi.fn().mockResolvedValue(undefined), listKeys: vi.fn() },
			orphans: { record },
			logger: { error: vi.fn() },
		});

		await expect(coordinator.deleteOrQueue('public', 'already-gone.png', 'cleanup'))
			.resolves.toBeUndefined();
		expect(record).not.toHaveBeenCalled();
	});

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

	it('rejects when neither storage deletion nor durable orphan recording succeeds', async () => {
		const deleteError = new Error('storage unavailable');
		const queueError = new Error('database unavailable');
		const logError = vi.fn();
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: vi.fn().mockRejectedValue(deleteError),
				listKeys: vi.fn(),
			},
			orphans: { record: vi.fn().mockRejectedValue(queueError) },
			logger: { error: logError },
		});

		const failure = await coordinator.deleteOrQueue(
			'protected',
			'games/untracked.zip',
			'game-replaced',
			{ projectId: 7 },
		).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(DurableObjectDeletionError);
		expect(failure).toMatchObject({
			bucket: 'protected',
			storageKey: 'games/untracked.zip',
			reason: 'game-replaced',
			deleteError,
			queueError,
			cause: queueError,
		});
		expect(logError).toHaveBeenLastCalledWith(
			expect.objectContaining({
				err: queueError,
				deleteError,
				projectId: 7,
			}),
			'Object delete and durable orphan recording both failed',
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

	it('queues the prefix itself when enumeration fails', async () => {
		const record = vi.fn().mockResolvedValue(undefined);
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: vi.fn(),
				listKeys: vi.fn().mockRejectedValue(new Error('list unavailable')),
			},
			orphans: { record },
			logger: { error: vi.fn() },
		});

		await expect(coordinator.deletePrefixOrQueue('public', 'webgl/7/build/site/', 'rollback'))
			.resolves.toBe(0);
		expect(record).toHaveBeenCalledWith('public', 'webgl/7/build/site/', 'rollback');
	});

	it('retains the existing transactional outbox instead of attempting a second queue write', async () => {
		const record = vi.fn().mockRejectedValue(new Error('database unavailable'));
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: vi.fn().mockRejectedValue(new Error('storage unavailable')),
				listKeys: vi.fn().mockRejectedValue(new Error('storage unavailable')),
			},
			orphans: { record },
			logger: { error: vi.fn() },
		});

		await expect(coordinator.deleteDurablyQueued('protected', 'games/old.zip', 'replace'))
			.resolves.toBeUndefined();
		await expect(coordinator.deleteDurablyQueuedPrefix('public', 'webgl/7/build/site/', 'replace'))
			.resolves.toBe(0);
		expect(record).not.toHaveBeenCalled();
	});
});
