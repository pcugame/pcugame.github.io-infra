import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DirectoryEntry, FileSystem } from '../application/ports.js';
import {
	LEGACY_UPLOAD_RECOVERY_MARKER,
	createActiveUploadTempRegistry,
	createUploadTempFileSystem,
	createUploadTempScavenger,
} from '../modules/upload-intent/temp-scavenger.js';

const ROOT = '/host-tmp';
const DEDICATED = `${ROOT}/pcugame-upload`;
const NOW = new Date('2026-08-18T12:00:00.000Z');
const OLD = new Date('2026-08-18T10:00:00.000Z');

function owned(name: string, directory = DEDICATED, isFile = true): DirectoryEntry {
	return { name, path: path.join(directory, name), isFile };
}

function missing(): Error & { code: string } {
	return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

function logger() {
	return { info: vi.fn(), error: vi.fn() };
}

describe('bounded upload temp scavenger invariants', () => {
	it('prefilters entry type, UUID grammar, suffixes, and path boundary before stat', async () => {
		const exact = 'pcu-project-upload-11111111-1111-4111-8111-111111111111';
		const fresh = 'project-asset-22222222-2222-4222-8222-222222222222.webp';
		const future = 'exhibition-poster-33333333-3333-4333-8333-333333333333.playback.mp4';
		const oldSuffixes = [
			'pcu-project-upload-44444444-4444-4444-8444-444444444444.card-480.webp',
			'project-asset-55555555-5555-4555-8555-555555555555.display-960.webp',
		];
		const valid = [exact, fresh, future, ...oldSuffixes];
		const entries = [
			...valid.map((name) => owned(name)),
			owned('pcu-project-upload-not-a-uuid'),
			owned('project-asset-66666666-6666-4666-8666-666666666666.unknown'),
			owned('exhibition-poster-77777777-7777-4777-8777-777777777777', DEDICATED, false),
			{
				...owned('pcu-project-upload-88888888-8888-4888-8888-888888888888'),
				path: `${ROOT}/pcu-project-upload-88888888-8888-4888-8888-888888888888`,
			},
		];
		const stat = vi.fn(async (filePath: string) => ({
			size: 1,
			lastModified: filePath.includes('11111111')
				? new Date('2026-08-18T11:00:00.000Z') // exact TTL fence
				: filePath.includes('22222222')
					? new Date('2026-08-18T11:00:00.001Z')
					: filePath.includes('33333333')
						? new Date('2026-08-19T00:00:00.000Z')
						: OLD,
		}));
		const remove = vi.fn(async (_filePath: string) => {});
		const scavenger = createUploadTempScavenger({
			fileSystem: {
				temporaryDirectory: () => DEDICATED,
				stat,
				remove,
				access: vi.fn(),
				mkdir: vi.fn(),
				listDirectoryEntries: vi.fn(async () => entries),
			},
			clock: { now: () => NOW },
			logger: logger(),
		});

		await expect(scavenger.sweep()).resolves.toEqual({
			scanned: entries.length,
			candidates: valid.length,
			removed: 3,
			failed: 0,
		});
		expect(stat).toHaveBeenCalledTimes(valid.length);
		expect(remove.mock.calls.map(([filePath]) => path.basename(filePath))).toEqual(
			expect.arrayContaining([exact, ...oldSuffixes]),
		);
		expect(remove.mock.calls.map(([filePath]) => path.basename(filePath)))
			.not.toEqual(expect.arrayContaining([fresh, future]));
	});

	it('never enumerates the shared root during routine sweeps and bounds one-time legacy work by owned names', async () => {
		let markerExists = false;
		const unrelated = Array.from({ length: 10_000 }, (_, index) => (
			owned(`other-process-${index}`, ROOT)
		));
		const legacyOwned = [
			owned('pcu-project-upload-11111111-1111-4111-8111-111111111111.webp', ROOT),
			owned('project-asset-22222222-2222-4222-8222-222222222222', ROOT),
		];
		const rootList = vi.fn(async () => [...unrelated, ...legacyOwned]);
		const dedicatedList = vi.fn(async () => [
			owned('exhibition-poster-33333333-3333-4333-8333-333333333333'),
		]);
		const stat = vi.fn(async () => ({ size: 1, lastModified: OLD }));
		const remove = vi.fn(async () => {});
		const mkdir = vi.fn(async (markerPath: string) => {
			if (markerPath.endsWith(LEGACY_UPLOAD_RECOVERY_MARKER)) markerExists = true;
		});
		const scavenger = createUploadTempScavenger({
			fileSystem: {
				temporaryDirectory: () => DEDICATED,
				stat,
				remove,
				access: vi.fn(async () => { if (!markerExists) throw missing(); }),
				mkdir,
				listDirectoryEntries: vi.fn(async (directory: string) => (
					directory === ROOT ? rootList() : dedicatedList()
				)),
			},
			legacyRootDirectory: ROOT,
			clock: { now: () => NOW },
			logger: logger(),
			concurrency: 3,
		});

		await scavenger.sweep();
		expect(rootList).not.toHaveBeenCalled();
		expect(stat).toHaveBeenCalledTimes(1);

		stat.mockClear();
		await scavenger.recoverOnStartup();
		expect(rootList).toHaveBeenCalledOnce();
		expect(stat).toHaveBeenCalledTimes(legacyOwned.length + 1);
		expect(mkdir).toHaveBeenCalledWith(`${DEDICATED}/${LEGACY_UPLOAD_RECOVERY_MARKER}`);

		stat.mockClear();
		await scavenger.recoverOnStartup();
		expect(rootList).toHaveBeenCalledOnce();
		expect(stat).toHaveBeenCalledTimes(1);
	});

	it('marks a failed legacy enumeration as attempted and does not retry it indefinitely', async () => {
		let markerExists = false;
		const rootList = vi.fn(async () => { throw new Error('root readdir denied'); });
		const scavenger = createUploadTempScavenger({
			fileSystem: {
				temporaryDirectory: () => DEDICATED,
				stat: vi.fn(),
				remove: vi.fn(),
				access: vi.fn(async () => { if (!markerExists) throw missing(); }),
				mkdir: vi.fn(async () => { markerExists = true; }),
				listDirectoryEntries: vi.fn(async (directory: string) => (
					directory === ROOT ? rootList() : []
				)),
			},
			legacyRootDirectory: ROOT,
			clock: { now: () => NOW },
			logger: logger(),
		});

		await expect(scavenger.recoverOnStartup()).resolves.toMatchObject({ failed: 1 });
		await expect(scavenger.recoverOnStartup()).resolves.toMatchObject({ failed: 0 });
		expect(rootList).toHaveBeenCalledOnce();
	});

	it.each([10, 10_000])(
		'keeps legacy stat/remove work and peak concurrency independent of %i unrelated root entries',
		async (unrelatedCount) => {
			const candidates = Array.from({ length: 7 }, (_, index) => owned(
				`pcu-project-upload-${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
				ROOT,
			));
			const entries = [
				...Array.from({ length: unrelatedCount }, (_, index) => owned(`unrelated-${index}`, ROOT)),
				...candidates,
			];
			let current = 0;
			let peak = 0;
			async function measured<T>(value: T): Promise<T> {
				current++;
				peak = Math.max(peak, current);
				await new Promise<void>((resolve) => setImmediate(resolve));
				current--;
				return value;
			}
			const stat = vi.fn(async () => measured({ size: 1, lastModified: OLD }));
			const remove = vi.fn(async () => measured(undefined));
			const scavenger = createUploadTempScavenger({
				fileSystem: {
					temporaryDirectory: () => DEDICATED,
					stat,
					remove,
					access: vi.fn(async () => { throw missing(); }),
					mkdir: vi.fn(),
					listDirectoryEntries: vi.fn(async (directory: string) => (
						directory === ROOT ? entries : []
					)),
				},
				legacyRootDirectory: ROOT,
				clock: { now: () => NOW },
				logger: logger(),
				concurrency: 3,
			});

			await scavenger.recoverOnStartup();
			expect(stat).toHaveBeenCalledTimes(candidates.length);
			expect(remove).toHaveBeenCalledTimes(candidates.length);
			expect(peak).toBe(3);
		},
	);

	it('uses a real bounded worker pool and coalesces overlapping sweeps', async () => {
		const entries = Array.from({ length: 31 }, (_, index) => owned(
			`project-asset-${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
		));
		let current = 0;
		let peak = 0;
		const stat = vi.fn(async () => {
			current++;
			peak = Math.max(peak, current);
			await new Promise<void>((resolve) => setImmediate(resolve));
			current--;
			return { size: 1, lastModified: OLD };
		});
		const listDirectoryEntries = vi.fn(async () => entries);
		const scavenger = createUploadTempScavenger({
			fileSystem: {
				temporaryDirectory: () => DEDICATED,
				stat,
				remove: vi.fn(async () => {}),
				access: vi.fn(),
				mkdir: vi.fn(),
				listDirectoryEntries,
			},
			clock: { now: () => NOW },
			logger: logger(),
			concurrency: 4,
		});

		const first = scavenger.sweep();
		const overlapping = scavenger.sweep();
		expect(overlapping).toBe(first);
		await first;
		expect(listDirectoryEntries).toHaveBeenCalledOnce();
		expect(stat).toHaveBeenCalledTimes(entries.length);
		expect(peak).toBeLessThanOrEqual(4);
		expect(peak).toBe(4);
	});

	it('does not let pre-aborted sweep or startup calls occupy the single-flight slot', async () => {
		const listDirectoryEntries = vi.fn(async () => []);
		const access = vi.fn(async () => {});
		const scavenger = createUploadTempScavenger({
			fileSystem: {
				temporaryDirectory: () => DEDICATED,
				stat: vi.fn(),
				remove: vi.fn(),
				access,
				mkdir: vi.fn(),
				listDirectoryEntries,
			},
			legacyRootDirectory: ROOT,
			clock: { now: () => NOW },
			logger: logger(),
		});
		const aborted = new AbortController();
		aborted.abort();

		await Promise.all([
			scavenger.sweep(aborted.signal),
			scavenger.sweep(),
		]);
		expect(listDirectoryEntries).toHaveBeenCalledTimes(1);

		listDirectoryEntries.mockClear();
		await Promise.all([
			scavenger.recoverOnStartup(aborted.signal),
			scavenger.recoverOnStartup(),
		]);
		expect(access).toHaveBeenCalledOnce();
		expect(listDirectoryEntries).toHaveBeenCalledTimes(1);
	});

	it('rechecks active ownership, treats ENOENT as benign, and isolates other failures', async () => {
		const activeBase = `${DEDICATED}/pcu-project-upload-11111111-1111-4111-8111-111111111111`;
		const activeDerived = `${activeBase}.card-480.webp`;
		const missingStat = `${DEDICATED}/project-asset-22222222-2222-4222-8222-222222222222`;
		const missingRemove = `${DEDICATED}/project-asset-33333333-3333-4333-8333-333333333333`;
		const failedRemove = `${DEDICATED}/exhibition-poster-44444444-4444-4444-8444-444444444444.webp`;
		const registry = createActiveUploadTempRegistry();
		registry.register(activeBase);
		const stat = vi.fn(async (filePath: string) => {
			if (filePath === missingStat) throw missing();
			return { size: 1, lastModified: OLD };
		});
		const remove = vi.fn(async (filePath: string) => {
			if (filePath === missingRemove) throw missing();
			if (filePath === failedRemove) throw new Error('permission denied');
		});
		const scavenger = createUploadTempScavenger({
			fileSystem: {
				temporaryDirectory: () => DEDICATED,
				stat,
				remove,
				access: vi.fn(),
				mkdir: vi.fn(),
				listDirectoryEntries: vi.fn(async () => [
					owned(path.basename(activeDerived)),
					owned(path.basename(missingStat)),
					owned(path.basename(missingRemove)),
					owned(path.basename(failedRemove)),
				]),
			},
			active: registry,
			clock: { now: () => NOW },
			logger: logger(),
		});

		await expect(scavenger.sweep()).resolves.toMatchObject({ removed: 0, failed: 1 });
		expect(stat).not.toHaveBeenCalledWith(activeDerived);
		registry.release(activeBase);
		await expect(scavenger.sweep()).resolves.toMatchObject({ removed: 1, failed: 1 });
		expect(remove).toHaveBeenCalledWith(activeDerived);

		const restartedRegistry = createActiveUploadTempRegistry();
		expect(restartedRegistry.isActive(activeDerived)).toBe(false);
	});

	it('honors active and abort state changes between stat and remove', async () => {
		const activeName = 'project-asset-11111111-1111-4111-8111-111111111111';
		const abortName = 'project-asset-22222222-2222-4222-8222-222222222222';
		const activePath = `${DEDICATED}/${activeName}`;
		const controller = new AbortController();
		const registry = createActiveUploadTempRegistry();
		const remove = vi.fn(async (_filePath: string) => {});
		const stat = vi.fn(async (filePath: string) => {
			if (filePath === activePath) registry.register(activePath);
			else controller.abort();
			return { size: 1, lastModified: OLD };
		});
		const scavenger = createUploadTempScavenger({
			fileSystem: {
				temporaryDirectory: () => DEDICATED,
				stat,
				remove,
				access: vi.fn(),
				mkdir: vi.fn(),
				listDirectoryEntries: vi.fn(async () => [owned(activeName), owned(abortName)]),
			},
			active: registry,
			clock: { now: () => NOW },
			logger: logger(),
			concurrency: 1,
		});

		await scavenger.sweep(controller.signal);
		expect(stat).toHaveBeenCalledTimes(2);
		expect(remove).not.toHaveBeenCalled();
	});

	it('creates the dedicated filesystem view without I/O and preserves the global temp contract', async () => {
		const mkdir = vi.fn(async () => {});
		const base = {
			temporaryDirectory: vi.fn(() => ROOT),
			stat: vi.fn(),
			access: vi.fn(),
			mkdir,
			rename: vi.fn(),
			remove: vi.fn(),
			readRange: vi.fn(),
			createReadStream: vi.fn(),
			createWriteStream: vi.fn(),
			listDirectoryEntries: vi.fn(),
		} as unknown as FileSystem;

		const view = createUploadTempFileSystem(base);
		expect(base.temporaryDirectory()).toBe(ROOT);
		expect(view.temporaryDirectory()).toBe(DEDICATED);
		expect(mkdir).not.toHaveBeenCalled();
		await view.mkdir(view.temporaryDirectory(), { recursive: true });
		expect(mkdir).toHaveBeenCalledWith(DEDICATED, { recursive: true });
	});
});
