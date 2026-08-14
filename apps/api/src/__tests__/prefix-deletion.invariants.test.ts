import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import {
	createObjectDeletionCoordinator,
	DurablePrefixDeletionError,
} from '../application/object-deletion.js';
import { createObjectStorage } from '../lib/storage.js';
import { createOrphanService } from '../modules/orphan/service.js';
import type { ObjectReferenceInventory } from '../modules/orphan/reference-resolver.js';
import { createWebglDeployment } from '../modules/webgl/deployment.js';
import type { WebglDeploymentKeys } from '../modules/webgl/paths.js';

const key = (n: number) => `site/${String(n).padStart(4, '0')}.js`;
const webglDeployment: WebglDeploymentKeys = {
	projectId: 7,
	deploymentId: '123e4567-e89b-42d3-a456-426614174000',
	deploymentPrefix: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/',
	sourceKey: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/source.zip',
	sitePrefix: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/site/',
	entryKey: 'webgl/7/123e4567-e89b-42d3-a456-426614174000/site/index.html',
};

describe('issue #29 prefix deletion invariants', () => {
	it('coalesces short, truncated list pages into <=1000-key DeleteObjects batches without DeleteObject fallback', async () => {
		const live = new Set(Array.from({ length: 2501 }, (_, index) => key(index)));
		const commands: unknown[] = [];
		const send = vi.fn(async (command: unknown) => {
			commands.push(command);
			if (command instanceof ListObjectsV2Command) {
				const input = command.input;
				const candidates = [...live]
					.filter((value) => value.startsWith(input.Prefix ?? '') && value > (input.StartAfter ?? ''))
					.sort();
				// S3 is allowed to return a short truncated page.  This deliberately
				// exercises batching independently of page shape.
				const page = candidates.slice(0, 1);
				return { Contents: page.map((Key) => ({ Key })), IsTruncated: candidates.length > page.length };
			}
			if (command instanceof DeleteObjectsCommand) {
				const requested = command.input.Delete?.Objects?.map(({ Key }) => Key) ?? [];
				for (const value of requested) live.delete(value!);
				return { Deleted: requested.map((Key) => ({ Key })) };
			}
			throw new Error(`unexpected S3 command ${(command as { constructor?: { name?: string } }).constructor?.name}`);
		});
		const storage = createObjectStorage({ send } as unknown as S3Client, { defaultPresignTtlSec: 60 });
		const coordinator = createObjectDeletionCoordinator({
			storage,
			orphans: { record: vi.fn() },
			logger: { error: vi.fn() },
			prefixMaxListPages: 3000,
		});

		await expect(coordinator.deletePrefixOrQueue('public', 'site/', 'test')).resolves.toBe(2501);
		const bulk = commands.filter((command): command is DeleteObjectsCommand => command instanceof DeleteObjectsCommand);
		expect(bulk).toHaveLength(3);
		expect(bulk.map((command) => command.input.Delete?.Objects?.length)).toEqual([1000, 1000, 501]);
		expect(commands.some((command) => command instanceof DeleteObjectCommand)).toBe(false);
		const lists = commands.filter((command): command is ListObjectsV2Command => command instanceof ListObjectsV2Command);
		const cursors = lists.map((command) => command.input.StartAfter).filter((value): value is string => value !== undefined);
		expect(cursors.every((value, index) => index === 0 || value > cursors[index - 1]!)).toBe(true);
		expect(lists.at(-1)!.input).toMatchObject({ Prefix: 'site/', MaxKeys: 1 }); // fresh head check
		expect(live).toEqual(new Set());
	});

	it('rejects a page budget too small to preserve batch-based request scaling', async () => {
		const listKeyPage = vi.fn();
		const deleteKeys = vi.fn();
		const coordinator = createObjectDeletionCoordinator({
			storage: { delete: vi.fn(), listKeyPage, deleteKeys },
			orphans: { record: vi.fn() },
			logger: { error: vi.fn() },
			prefixPageSize: 3,
			prefixMaxListPages: 2,
		});

		await expect(coordinator.deletePrefixOrQueue('public', 'site/', 'budget'))
			.rejects.toThrow('maxListPages must be at least pageSize');
		expect(listKeyPage).not.toHaveBeenCalled();
		expect(deleteKeys).not.toHaveBeenCalled();
	});

	it('flushes a pending sub-batch at a valid page budget so retries make bounded progress', async () => {
		const live = new Set(['site/a', 'site/b', 'site/c', 'site/d', 'site/e']);
		const batches: string[][] = [];
		const record = vi.fn().mockResolvedValue(undefined);
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: vi.fn(),
				listKeyPage: vi.fn(async (_bucket, prefix, page) => {
					const candidates = [...live]
						.filter((value) => value.startsWith(prefix) && value > (page.startAfter ?? ''))
						.sort();
					const count = page.startAfter === undefined ? 2 : 1;
					return { keys: candidates.slice(0, count), isTruncated: candidates.length > count };
				}),
				deleteKeys: vi.fn(async (_bucket, keys) => {
					batches.push([...keys]);
					for (const value of keys) live.delete(value);
					return { deleted: [...keys], failures: [] };
				}),
			},
			orphans: { record },
			logger: { error: vi.fn() },
			prefixPageSize: 3,
			prefixMaxListPages: 3,
		});

		await expect(coordinator.deletePrefixOrQueue('public', 'site/', 'budget')).resolves.toBe(4);
		await expect(coordinator.deletePrefixOrQueue('public', 'site/', 'budget')).resolves.toBe(1);
		expect(batches).toEqual([['site/a', 'site/b', 'site/c'], ['site/d'], ['site/e']]);
		expect(live).toEqual(new Set());
		expect(record).toHaveBeenCalledOnce();
		expect(record).toHaveBeenCalledWith('public', 'site/', 'budget', 'PREFIX');
	});

	it('rejects malformed lists at the production adapter boundary and strictly accounts for every bulk response member', async () => {
		const send = vi.fn();
		const storage = createObjectStorage({ send } as unknown as S3Client, { defaultPresignTtlSec: 60 });

		send.mockResolvedValueOnce({ Contents: [{ Key: 'other/outside' }], IsTruncated: false });
		await expect(storage.listKeyPage!('public', 'site/', { maxKeys: 10 }))
			.rejects.toThrow('outside the requested prefix');

		send.mockResolvedValueOnce({ Contents: [{ Key: 'site/a' }, { Key: 'site/a' }], IsTruncated: false });
		await expect(storage.listKeyPage!('public', 'site/', { startAfter: 'site/0', maxKeys: 10 }))
			.rejects.toThrow('duplicate or non-ascending');
		send.mockResolvedValueOnce({ Contents: [{ Key: 'site/0' }], IsTruncated: false });
		await expect(storage.listKeyPage!('public', 'site/', { startAfter: 'site/0', maxKeys: 10 }))
			.rejects.toThrow('at or before StartAfter');
		send.mockResolvedValueOnce({ Contents: [], IsTruncated: true });
		await expect(storage.listKeyPage!('public', 'site/', { maxKeys: 10 }))
			.rejects.toThrow('empty truncated');

		await expect(storage.deleteKeys!('public', ['site/a', 'site/a']))
			.rejects.toThrow('distinct');
		await expect(storage.deleteKeys!('public', Array.from({ length: 1001 }, (_, index) => key(index))))
			.rejects.toThrow('between 1 and 1000');

		send.mockResolvedValueOnce({ Deleted: [{ Key: 'site/a' }], Errors: [{ Key: 'site/b', Code: 'AccessDenied' }] });
		await expect(storage.deleteKeys!('public', ['site/a', 'site/b']))
			.resolves.toEqual({ deleted: ['site/a'], failures: [{ key: 'site/b', code: 'AccessDenied' }] });

		send.mockResolvedValueOnce({ Errors: [{ Key: 'site/a', Code: 'NoSuchKey' }] });
		await expect(storage.deleteKeys!('public', ['site/a']))
			.resolves.toEqual({ deleted: ['site/a'], failures: [] });
		send.mockRejectedValueOnce(new Error('network timeout'));
		await expect(storage.deleteKeys!('public', ['site/a'])).rejects.toThrow('network timeout');

		for (const response of [
			{ Deleted: [{ Key: 'site/a' }] },
			{ Deleted: [{ Key: 'site/a' }, { Key: 'site/a' }] },
			{ Deleted: [{ Key: 'site/a' }], Errors: [{ Key: 'site/a', Code: 'AccessDenied' }] },
			{ Deleted: [{ Key: 'site/unexpected' }], Errors: [{ Key: 'site/a', Code: 'AccessDenied' }] },
		]) {
			send.mockResolvedValueOnce(response);
			await expect(storage.deleteKeys!('public', ['site/a', 'site/b']))
				.rejects.toThrow('protocol ambiguity');
		}
	});

	it('hands partial failures to one parent PREFIX, continues later pages, and never retries them in the same sweep', async () => {
		const record = vi.fn().mockResolvedValue(undefined);
		const listKeyPage = vi.fn()
			.mockResolvedValueOnce({ keys: ['site/a', 'site/b'], isTruncated: true })
			.mockResolvedValueOnce({ keys: ['site/c'], isTruncated: false })
			// b remains after its confirmed partial failure; the parent prefix owns
			// durable recovery, so this attempt must not re-delete it.
			.mockResolvedValue({ keys: ['site/b'], isTruncated: false });
		const deleteKeys = vi.fn(async (_bucket: string, keys: readonly string[]) => ({
			deleted: keys.filter((value) => value !== 'site/b'),
			failures: keys.includes('site/b') ? [{ key: 'site/b', code: 'AccessDenied' }] : [],
		}));
		const coordinator = createObjectDeletionCoordinator({
			storage: { delete: vi.fn(), listKeyPage, deleteKeys },
			orphans: { record }, logger: { error: vi.fn() },
		});

		await expect(coordinator.deletePrefixOrQueue('public', 'site/', 'rollback')).resolves.toBe(3);
		expect(deleteKeys).toHaveBeenCalledOnce();
		expect(deleteKeys).toHaveBeenCalledWith('public', ['site/a', 'site/b', 'site/c'], undefined);
		expect(record).toHaveBeenCalledOnce();
		expect(record).toHaveBeenCalledWith('public', 'site/', 'rollback', 'PREFIX');
	});

	it('does not fan an all-key partial batch into per-key recovery rows', async () => {
		const failedKeys = Array.from({ length: 1000 }, (_, index) => key(index));
		const record = vi.fn().mockResolvedValue(undefined);
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: vi.fn(),
				listKeyPage: vi.fn().mockResolvedValue({ keys: failedKeys, isTruncated: false }),
				deleteKeys: vi.fn().mockResolvedValue({
					deleted: [],
					failures: failedKeys.map((failedKey) => ({ key: failedKey, code: 'SlowDown' })),
				}),
			},
			orphans: { record }, logger: { error: vi.fn() },
		});

		await expect(coordinator.deletePrefixOrQueue('public', 'site/', 'rollback'))
			.resolves.toBe(1000);
		expect(record).toHaveBeenCalledOnce();
		expect(record).toHaveBeenCalledWith('public', 'site/', 'rollback', 'PREFIX');
	});

	it('rejects with DurablePrefixDeletionError when the first partial cannot durably cover its parent prefix', async () => {
		const queueError = new Error('prefix outbox unavailable');
		const record = vi.fn().mockRejectedValue(queueError);
		const coordinator = createObjectDeletionCoordinator({
			storage: {
				delete: vi.fn(),
				listKeyPage: vi.fn().mockResolvedValue({ keys: ['site/a'], isTruncated: false }),
				deleteKeys: vi.fn().mockResolvedValue({ deleted: [], failures: [{ key: 'site/a', code: 'AccessDenied' }] }),
			},
			orphans: { record }, logger: { error: vi.fn() },
		});

		await expect(coordinator.deletePrefixOrQueue('public', 'site/', 'rollback'))
			.rejects.toBeInstanceOf(DurablePrefixDeletionError);
		expect(record).toHaveBeenCalledOnce();
		expect(record).toHaveBeenCalledWith('public', 'site/', 'rollback', 'PREFIX');
	});

	it('covers a behind-cursor concurrent insertion with its parent PREFIX after a confirmed partial', async () => {
		const live = new Set(['site/a', 'site/b', 'site/c']);
		const record = vi.fn().mockResolvedValue(undefined);
		const listKeyPage = vi.fn()
			.mockResolvedValueOnce({ keys: ['site/a', 'site/b'], isTruncated: true })
			.mockResolvedValueOnce({ keys: ['site/c'], isTruncated: false });
		const deleteKeys = vi.fn(async (_bucket: string, keys: readonly string[]) => {
			for (const value of keys) if (value !== 'site/b') live.delete(value);
			// A writer inserts before the already-advanced lexical cursor. It cannot
			// be reached in this sweep, so success must rely on parent recovery.
			live.add('site/0-concurrent.js');
			return { deleted: keys.filter((value) => value !== 'site/b'), failures: [{ key: 'site/b', code: 'AccessDenied' }] };
		});
		const coordinator = createObjectDeletionCoordinator({
			storage: { delete: vi.fn(), listKeyPage, deleteKeys },
			orphans: { record }, logger: { error: vi.fn() },
		});

		await expect(coordinator.deletePrefixOrQueue('public', 'site/', 'rollback')).resolves.toBe(3);
		expect(live).toEqual(new Set(['site/b', 'site/0-concurrent.js']));
		expect(listKeyPage).toHaveBeenCalledTimes(2); // does not falsely fresh-sweep known partial failure
		expect(record).toHaveBeenCalledOnce();
		expect(record).toHaveBeenCalledWith('public', 'site/', 'rollback', 'PREFIX');
	});

	it('reaper renews immediately before every list/delete, requeues a partial second batch, and never resolves the parent', async () => {
		const now = new Date('2026-08-14T00:00:00.000Z');
		const events: string[] = [];
		const batchOne = Array.from({ length: 1000 }, (_, index) => key(index));
		const repository = {
			upsertOrphan: vi.fn(),
			claimPendingOrphans: vi.fn().mockResolvedValue([{ id: 29, bucket: 'public', storageKey: 'site/', targetKind: 'PREFIX' as const, attemptCount: 0 }]),
			markClaimResolved: vi.fn().mockResolvedValue({ count: 1 }),
			renewActiveClaim: vi.fn(async () => { events.push('renew'); return { count: 1 }; }),
			markClaimCancelled: vi.fn().mockResolvedValue({ count: 1 }),
			markClaimFailed: vi.fn().mockResolvedValue({ count: 1 }),
		};
		const storage = {
			delete: vi.fn(), listKeys: vi.fn(),
			listKeyPage: vi.fn(async () => {
				events.push('list');
				return events.filter((event) => event === 'list').length === 1
					? { keys: batchOne, isTruncated: true }
					: { keys: ['site/1000.js'], isTruncated: false };
			}),
			deleteKeys: vi.fn(async (_bucket: string, keys: readonly string[]) => {
				events.push(`delete:${keys.length}:${keys[0]}`);
				return keys.length === 1000
					? { deleted: [...keys], failures: [] }
					: { deleted: [], failures: [{ key: 'site/1000.js', code: 'AccessDenied' }] };
			}),
		};
		const service = createOrphanService({
			clock: { now: () => now }, storage, repository,
			references: { collect: vi.fn(async (): Promise<ObjectReferenceInventory> => ({ references: [], unsafeBuckets: new Set() })) },
			ids: { next: () => 'claim' }, logger: { info: vi.fn(), error: vi.fn() },
		});

		await expect(service.runOrphanReaper()).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
		expect(events).toEqual([
			'renew', 'list', 'renew', `delete:1000:${key(0)}`,
			'renew', 'list', 'renew', 'delete:1:site/1000.js',
		]);
		expect(repository.markClaimResolved).not.toHaveBeenCalled();
		expect(repository.markClaimFailed).toHaveBeenCalledOnce();
		expect(storage.listKeys).not.toHaveBeenCalled();
	});

	it('stops a claimed prefix attempt on interruption before a later batch and leaves its parent pending', async () => {
		const controller = new AbortController();
		const batchOne = Array.from({ length: 1000 }, (_, index) => key(index));
		const repository = {
			upsertOrphan: vi.fn(),
			claimPendingOrphans: vi.fn().mockResolvedValue([{ id: 30, bucket: 'public', storageKey: 'site/', targetKind: 'PREFIX' as const, attemptCount: 0 }]),
			markClaimResolved: vi.fn().mockResolvedValue({ count: 1 }),
			renewActiveClaim: vi.fn().mockResolvedValue({ count: 1 }),
			markClaimCancelled: vi.fn().mockResolvedValue({ count: 1 }),
			markClaimFailed: vi.fn().mockResolvedValue({ count: 1 }),
		};
		const storage = {
			delete: vi.fn(), listKeys: vi.fn(),
			listKeyPage: vi.fn()
				.mockResolvedValueOnce({ keys: batchOne, isTruncated: true })
				.mockResolvedValueOnce({ keys: ['site/1000.js'], isTruncated: false }),
			deleteKeys: vi.fn(async (_bucket: string, keys: readonly string[]) => {
				controller.abort(new Error('worker shutdown'));
				return { deleted: [...keys], failures: [] };
			}),
		};
		const service = createOrphanService({
			clock: { now: () => new Date('2026-08-14T00:00:00.000Z') }, storage, repository,
			references: { collect: vi.fn(async (): Promise<ObjectReferenceInventory> => ({ references: [], unsafeBuckets: new Set() })) },
			ids: { next: () => 'claim' }, logger: { info: vi.fn(), error: vi.fn() },
		});

		await expect(service.runOrphanReaper(controller.signal)).resolves.toEqual({ tried: 1, resolved: 0, failed: 1 });
		expect(storage.deleteKeys).toHaveBeenCalledOnce();
		expect(repository.markClaimResolved).not.toHaveBeenCalled();
		expect(repository.markClaimFailed).toHaveBeenCalledOnce();
	});

	it('rollback forwards the completion signal and claim guards into every batch boundary, then stops on claim loss', async () => {
		const controller = new AbortController();
		const firstBatch = Array.from({ length: 1000 }, (_, index) => key(index));
		const listKeyPage = vi.fn(async (_bucket: string, _prefix: string, _page: unknown, request?: { signal?: AbortSignal }) => {
			expect(request?.signal).toBe(controller.signal);
			return { keys: firstBatch, isTruncated: true };
		});
		const deleteKeys = vi.fn(async (_bucket: string, keys: readonly string[], request?: { signal?: AbortSignal }) => {
			expect(keys).toEqual(firstBatch);
			expect(request?.signal).toBe(controller.signal);
			controller.abort(new Error('completion claim lost'));
			return { deleted: [...keys], failures: [] };
		});
		const coordinator = createObjectDeletionCoordinator({
			storage: { delete: vi.fn(), listKeyPage, deleteKeys },
			orphans: { record: vi.fn() }, logger: { error: vi.fn() },
		});
		const adapter = createWebglDeployment({
			config: { protectedBucket: 'protected', publicBucket: 'public' },
			storage: { readRange: vi.fn(), stream: vi.fn(), upload: vi.fn() },
			fileSystem: { temporaryDirectory: () => '/tmp', createWriteStream: vi.fn(), remove: vi.fn() },
			ids: { next: () => 'safe-id' }, deletion: coordinator,
			logger: { warn: vi.fn(), error: vi.fn() },
		});
		const assertClaimOwned = vi.fn(async () => undefined);

		await expect(adapter.rollbackPublicDeployment(webglDeployment, 'rollback', {
			storageRequest: { signal: controller.signal }, assertClaimOwned,
		})).rejects.toThrow('completion claim lost');
		expect(assertClaimOwned).toHaveBeenCalledTimes(2); // first list, then first delete
		expect(listKeyPage).toHaveBeenCalledOnce();
		expect(deleteKeys).toHaveBeenCalledOnce();
	});
});
