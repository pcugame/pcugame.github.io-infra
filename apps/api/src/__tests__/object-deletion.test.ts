import { describe, expect, it, vi } from 'vitest';
import {
	createObjectDeletionCoordinator,
	DurableObjectDeletionError,
} from '../application/object-deletion.js';

describe('object deletion coordinator', () => {
	it('does not write an orphan row when object storage deletion succeeds', async () => {
		const record = vi.fn().mockRejectedValue(new Error('queue must not be used'));
		const coordinator = createObjectDeletionCoordinator({
			storage: { delete: vi.fn().mockResolvedValue(undefined), listKeyPage: vi.fn(), deleteKeys: vi.fn() },
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
			storage: { delete: deleteObject, listKeyPage: vi.fn(), deleteKeys: vi.fn() },
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
				listKeyPage: vi.fn(),
				deleteKeys: vi.fn(),
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

	it('deletes prefix batches and hands confirmed partial failures to parent recovery', async () => {
		const deleteKeys = vi.fn().mockResolvedValue({
			deleted: ['site/1.js', 'site/3.js'],
			failures: [{ key: 'site/2.js', code: 'SlowDown' }],
		});
		const record = vi.fn().mockResolvedValue(undefined);
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: vi.fn(),
				listKeyPage: vi.fn()
					.mockResolvedValueOnce({ keys: ['site/1.js', 'site/2.js', 'site/3.js'], isTruncated: false })
					.mockResolvedValueOnce({ keys: [], isTruncated: false }),
				deleteKeys,
			},
			orphans: { record },
			logger: { error: vi.fn() },
		});

		await expect(coordinator.deletePrefixOrQueue('public', 'site/', 'deployment-delete'))
			.resolves.toBe(3);
		expect(deleteKeys).toHaveBeenCalledOnce();
		expect(record).toHaveBeenCalledOnce();
		expect(record).toHaveBeenCalledWith('public', 'site/', 'deployment-delete', 'PREFIX');
	});

	it('queues the prefix itself when enumeration fails', async () => {
		const record = vi.fn().mockResolvedValue(undefined);
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: vi.fn(),
				listKeyPage: vi.fn().mockRejectedValue(new Error('list unavailable')),
				deleteKeys: vi.fn(),
			},
			orphans: { record },
			logger: { error: vi.fn() },
		});

		await expect(coordinator.deletePrefixOrQueue('public', 'webgl/7/build/site/', 'rollback'))
			.resolves.toBe(0);
		expect(record).toHaveBeenCalledWith(
			'public',
			'webgl/7/build/site/',
			'rollback',
			'PREFIX',
		);
	});

	it('does not expose a transactional-outbox shortcut that can run a global reaper', () => {
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: vi.fn(),
				listKeyPage: vi.fn(),
				deleteKeys: vi.fn(),
			},
			orphans: { record: vi.fn() },
			logger: { error: vi.fn() },
		});

		expect(Object.keys(coordinator).sort()).toEqual([
			'deleteOrQueue',
			'deletePrefixOrQueue',
		]);
	});

	it('rejects prefix compensation when neither enumeration nor durable prefix recording works', async () => {
		const listError = new Error('storage unavailable');
		const queueError = new Error('database unavailable');
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: vi.fn(),
				listKeyPage: vi.fn().mockRejectedValue(listError),
				deleteKeys: vi.fn(),
			},
			orphans: { record: vi.fn().mockRejectedValue(queueError) },
			logger: { error: vi.fn() },
		});

		await expect(coordinator.deletePrefixOrQueue('public', 'webgl/7/site/', 'replace'))
			.rejects.toMatchObject({ input: { operationError: expect.any(Error), queueError } });
	});

	it('stops a guarded multi-batch rollback before any storage request after claim loss', async () => {
		const claimLost = new Error('completion claim lost');
		const listKeyPage = vi.fn().mockResolvedValue({ keys: ['site/a'], isTruncated: true });
		const deleteKeys = vi.fn().mockResolvedValue({ deleted: ['site/a'], failures: [] });
		const beforeList = vi.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(claimLost);
		const coordinator = createObjectDeletionCoordinator({
			storage: { delete: vi.fn(), listKeyPage, deleteKeys },
			orphans: { record: vi.fn() },
			logger: { error: vi.fn() },
			prefixPageSize: 1,
		});

		await expect(coordinator.deletePrefixOrQueue(
			'public', 'site/', 'webgl-deploy-rollback', {}, { beforeList },
		)).rejects.toBe(claimLost);
		expect(listKeyPage).toHaveBeenCalledOnce();
		expect(deleteKeys).toHaveBeenCalledOnce();
	});

	it('propagates an abort during bulk deletion without queueing the prefix', async () => {
		const controller = new AbortController();
		const abortReason = new Error('completion claim lost');
		const record = vi.fn();
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: vi.fn(),
				listKeyPage: vi.fn().mockResolvedValue({ keys: ['site/a'], isTruncated: false }),
				deleteKeys: vi.fn(async () => {
					controller.abort(abortReason);
					throw abortReason;
				}),
			},
			orphans: { record },
			logger: { error: vi.fn() },
		});

		await expect(coordinator.deletePrefixOrQueue(
			'public', 'site/', 'webgl-deploy-rollback', {}, { request: { signal: controller.signal } },
		)).rejects.toBe(abortReason);
		expect(record).not.toHaveBeenCalled();
	});
});
