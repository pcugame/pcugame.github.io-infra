import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DirectoryEntry, FileSystem } from '../application/ports.js';
import {
	LEGACY_UPLOAD_RECOVERY_ATTEMPT_PREFIX,
	LEGACY_UPLOAD_RECOVERY_CANDIDATE_PREFIX,
	LEGACY_UPLOAD_RECOVERY_DISCOVERY_BLOCKED,
	LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE,
	MAX_LEGACY_UPLOAD_DISCOVERY_ATTEMPTS,
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

function oldRegularFile() {
	return {
		size: 1,
		lastModified: OLD,
		isFile: true,
		isSymbolicLink: false,
		identity: { device: '1', inode: '1' },
	};
}

function recoveryRecordStore(initialNames: readonly string[] = []) {
	const records = new Set(initialNames);
	const contents = new Map(initialNames.map((name) => [name, '']));
	const createFileExclusive = vi.fn<NonNullable<FileSystem['createFileExclusive']>>(
		async (filePath, value = '') => {
			const name = path.basename(filePath);
			if (records.has(name)) return 'exists';
			records.add(name);
			contents.set(name, value);
			return 'created';
		},
	);
	const remove = vi.fn<FileSystem['remove']>(async (filePath) => {
		const name = path.basename(filePath);
		records.delete(name);
		contents.delete(name);
	});
	const entries = vi.fn<NonNullable<FileSystem['listDirectoryEntries']>>(
		async () => [...records].map((name) => owned(name)),
	);
	const readTextFile = vi.fn<NonNullable<FileSystem['readTextFile']>>(
		async (filePath) => contents.get(path.basename(filePath)) ?? '',
	);
	return { records, contents, createFileExclusive, remove, entries, readTextFile };
}

function recoveryFileSystem(options: {
	records: ReturnType<typeof recoveryRecordStore>;
	rootEntries?: () => Promise<DirectoryEntry[]>;
	lstat?: NonNullable<FileSystem['lstat']>;
	claimAndRemoveFile?: NonNullable<FileSystem['claimAndRemoveFile']>;
	createFileExclusive?: NonNullable<FileSystem['createFileExclusive']>;
}) {
	const listDirectoryEntries = vi.fn<NonNullable<FileSystem['listDirectoryEntries']>>(
		async (directory) => directory === ROOT
			? (options.rootEntries?.() ?? [])
			: options.records.entries(directory),
	);
	return {
		temporaryDirectory: () => DEDICATED,
		stat: vi.fn<FileSystem['stat']>(),
		lstat: vi.fn<NonNullable<FileSystem['lstat']>>(
			options.lstat ?? (async () => oldRegularFile()),
		),
		remove: options.records.remove,
		removeFileDurable: options.records.remove,
		access: vi.fn<FileSystem['access']>(),
		mkdir: vi.fn<FileSystem['mkdir']>(),
		createFileExclusive: vi.fn<NonNullable<FileSystem['createFileExclusive']>>(
			options.createFileExclusive ?? options.records.createFileExclusive,
		),
		readTextFile: options.records.readTextFile,
		claimAndRemoveFile: vi.fn<NonNullable<FileSystem['claimAndRemoveFile']>>(
			options.claimAndRemoveFile ?? (async () => 'removed'),
		),
		listDirectoryEntries,
	};
}

function candidateRecord(basename: string): string {
	return `${LEGACY_UPLOAD_RECOVERY_CANDIDATE_PREFIX}${basename}`;
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
			{ ...owned('pcu-project-upload-88888888-8888-4888-8888-888888888888'), path: `${ROOT}/escape` },
		];
		const stat = vi.fn<FileSystem['stat']>(async (filePath) => ({
			size: 1,
			lastModified: filePath.includes('11111111')
				? new Date('2026-08-18T11:00:00.000Z')
				: filePath.includes('22222222')
					? new Date('2026-08-18T11:00:00.001Z')
					: filePath.includes('33333333')
						? new Date('2026-08-19T00:00:00.000Z')
						: OLD,
		}));
		const remove = vi.fn<FileSystem['remove']>(async () => {});
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
	});

	it('never enumerates the shared root during a routine sweep', async () => {
		const rootList = vi.fn(async () => []);
		const dedicatedList = vi.fn(async () => []);
		const scavenger = createUploadTempScavenger({
			fileSystem: {
				temporaryDirectory: () => DEDICATED,
				stat: vi.fn(), remove: vi.fn(), access: vi.fn(), mkdir: vi.fn(),
				listDirectoryEntries: vi.fn(async (directory: string) => (
					directory === ROOT ? rootList() : dedicatedList()
				)),
			},
			legacyRootDirectory: ROOT,
			clock: { now: () => NOW }, logger: logger(),
		});

		await scavenger.sweep();
		expect(rootList).not.toHaveBeenCalled();
		expect(dedicatedList).toHaveBeenCalledOnce();
	});

	it('uses exclusive attempt slots and immutable complete only after a successful scan', async () => {
		const records = recoveryRecordStore();
		const rootEntries = vi.fn(async () => [owned('unrelated-entry', ROOT)]);
		const fileSystem = recoveryFileSystem({ records, rootEntries });
		const scavenger = createUploadTempScavenger({
			fileSystem, legacyRootDirectory: ROOT, clock: { now: () => NOW }, logger: logger(),
		});

		await scavenger.recoverOnStartup();
		expect(records.records.has(`${LEGACY_UPLOAD_RECOVERY_ATTEMPT_PREFIX}1`)).toBe(true);
		expect(records.records.has(LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE)).toBe(true);
		expect(records.records.has(LEGACY_UPLOAD_RECOVERY_DISCOVERY_BLOCKED)).toBe(false);
		await scavenger.recoverOnStartup();
		expect(rootEntries).toHaveBeenCalledOnce();
		expect(records.remove).not.toHaveBeenCalledWith(
			`${DEDICATED}/${LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE}`,
		);
	});

	it('publishes one pending record per safe basename before discovery-complete', async () => {
		const first = 'pcu-project-upload-11111111-1111-4111-8111-111111111111';
		const second = 'project-asset-22222222-2222-4222-8222-222222222222.webp';
		const records = recoveryRecordStore();
		const fileSystem = recoveryFileSystem({
			records,
			rootEntries: async () => [owned(first, ROOT), owned(second, ROOT)],
			lstat: async () => ({ ...oldRegularFile(), lastModified: NOW }),
		});
		const scavenger = createUploadTempScavenger({
			fileSystem, legacyRootDirectory: ROOT, clock: { now: () => NOW }, logger: logger(),
		});

		await scavenger.recoverOnStartup();
		for (const name of [first, second]) expect(records.records.has(candidateRecord(name))).toBe(true);
		const created = fileSystem.createFileExclusive.mock.calls.map(([value]) => path.basename(value));
		for (const name of [first, second]) {
			expect(created.indexOf(candidateRecord(name)))
				.toBeLessThan(created.indexOf(LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE));
		}
	});

	it('caps failed discovery attempts and records blocked without complete', async () => {
		const records = recoveryRecordStore();
		const rootEntries = vi.fn(async () => { throw new Error('root readdir denied'); });
		const fileSystem = recoveryFileSystem({ records, rootEntries });
		const scavenger = createUploadTempScavenger({
			fileSystem, legacyRootDirectory: ROOT, clock: { now: () => NOW }, logger: logger(),
		});

		for (let index = 0; index < MAX_LEGACY_UPLOAD_DISCOVERY_ATTEMPTS + 2; index++) {
			await scavenger.recoverOnStartup();
		}
		expect(rootEntries).toHaveBeenCalledTimes(MAX_LEGACY_UPLOAD_DISCOVERY_ATTEMPTS);
		for (let slot = 1; slot <= MAX_LEGACY_UPLOAD_DISCOVERY_ATTEMPTS; slot++) {
			expect(records.records.has(`${LEGACY_UPLOAD_RECOVERY_ATTEMPT_PREFIX}${slot}`)).toBe(true);
		}
		expect(records.records.has(LEGACY_UPLOAD_RECOVERY_DISCOVERY_BLOCKED)).toBe(true);
		expect(records.records.has(LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE)).toBe(false);
	});

	it('cleans pending records only after identity claim reports removed or missing', async () => {
		const names = {
			removed: 'pcu-project-upload-11111111-1111-4111-8111-111111111111',
			missingStat: 'project-asset-22222222-2222-4222-8222-222222222222',
			missingClaim: 'exhibition-poster-33333333-3333-4333-8333-333333333333',
			changed: 'pcu-project-upload-44444444-4444-4444-8444-444444444444',
			fresh: 'project-asset-55555555-5555-4555-8555-555555555555',
			active: 'exhibition-poster-66666666-6666-4666-8666-666666666666',
			inspectFailure: 'pcu-project-upload-77777777-7777-4777-8777-777777777777',
			claimFailure: 'project-asset-88888888-8888-4888-8888-888888888888',
		};
		const records = recoveryRecordStore([
			LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE,
			...Object.values(names).map(candidateRecord),
		]);
		const lstat = vi.fn<NonNullable<FileSystem['lstat']>>(async (filePath) => {
			if (filePath.endsWith(names.missingStat)) throw missing();
			if (filePath.endsWith(names.inspectFailure)) throw new Error('permission denied');
			if (filePath.endsWith(names.fresh)) return { ...oldRegularFile(), lastModified: NOW };
			return oldRegularFile();
		});
		const claim = vi.fn<NonNullable<FileSystem['claimAndRemoveFile']>>(async (
			filePath, _quarantineDirectory, expected,
		) => {
			if (expected === undefined) return 'missing';
			if (filePath.endsWith(names.missingClaim)) return 'missing';
			if (filePath.endsWith(names.changed)) return 'changed';
			if (filePath.endsWith(names.claimFailure)) throw new Error('busy');
			return 'removed';
		});
		const fileSystem = recoveryFileSystem({ records, lstat, claimAndRemoveFile: claim });
		const scavenger = createUploadTempScavenger({
			fileSystem,
			legacyRootDirectory: ROOT,
			active: { isActive: (filePath) => filePath.endsWith(names.active) },
			clock: { now: () => NOW }, logger: logger(),
		});

		await scavenger.recoverOnStartup();
		for (const cleaned of [names.removed, names.missingStat, names.missingClaim]) {
			expect(records.records.has(candidateRecord(cleaned))).toBe(false);
		}
		for (const retained of [
			names.changed, names.fresh, names.active, names.inspectFailure, names.claimFailure,
		]) expect(records.records.has(candidateRecord(retained))).toBe(true);
		expect(claim).toHaveBeenCalledWith(
			`${ROOT}/${names.removed}`, DEDICATED,
			expect.objectContaining({ identity: { device: '1', inode: '1' } }),
		);
		expect(claim.mock.calls.some(([filePath]) => filePath.endsWith(names.active))).toBe(false);
	});

	it('keeps the pending record until the identity-bound claim has finished', async () => {
		const candidate = 'project-asset-11111111-1111-4111-8111-111111111111';
		const record = candidateRecord(candidate);
		const records = recoveryRecordStore([
			LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE,
			record,
		]);
		let claimEntered!: () => void;
		const atClaim = new Promise<void>((resolve) => { claimEntered = resolve; });
		let releaseClaim!: () => void;
		const claimReleased = new Promise<void>((resolve) => { releaseClaim = resolve; });
		const claim = vi.fn<NonNullable<FileSystem['claimAndRemoveFile']>>(async () => {
			claimEntered();
			await claimReleased;
			return 'removed';
		});
		const fileSystem = recoveryFileSystem({ records, claimAndRemoveFile: claim });
		const recovery = createUploadTempScavenger({
			fileSystem, legacyRootDirectory: ROOT, clock: { now: () => NOW }, logger: logger(),
		}).recoverOnStartup();

		await atClaim;
		expect(records.records.has(record)).toBe(true);
		expect(records.remove).not.toHaveBeenCalledWith(`${DEDICATED}/${record}`);
		releaseClaim();
		await recovery;
		expect(records.records.has(record)).toBe(false);
	});

	it('retries only the failed pending candidate without re-enumerating the root', async () => {
		const first = 'pcu-project-upload-11111111-1111-4111-8111-111111111111';
		const second = 'project-asset-22222222-2222-4222-8222-222222222222';
		const records = recoveryRecordStore([
			LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE,
			candidateRecord(first),
			candidateRecord(second),
		]);
		const rootEntries = vi.fn(async () => []);
		let failSecond = true;
		const claim = vi.fn<NonNullable<FileSystem['claimAndRemoveFile']>>(async (filePath) => {
			if (filePath.endsWith(second) && failSecond) throw new Error('busy');
			return 'removed';
		});
		const fileSystem = recoveryFileSystem({ records, rootEntries, claimAndRemoveFile: claim });
		const scavenger = createUploadTempScavenger({
			fileSystem, legacyRootDirectory: ROOT, clock: { now: () => NOW }, logger: logger(),
		});

		await expect(scavenger.recoverOnStartup()).resolves.toMatchObject({ removed: 1, failed: 1 });
		expect(records.records.has(candidateRecord(first))).toBe(false);
		expect(records.records.has(candidateRecord(second))).toBe(true);
		claim.mockClear();
		failSecond = false;
		await expect(scavenger.recoverOnStartup()).resolves.toMatchObject({ removed: 1, failed: 0 });
		expect(rootEntries).not.toHaveBeenCalled();
		expect(claim).toHaveBeenCalledOnce();
		expect(claim.mock.calls[0]?.[0]).toBe(`${ROOT}/${second}`);
		expect(records.records.has(candidateRecord(second))).toBe(false);
		expect(records.records.has(LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE)).toBe(true);
	});

	it('replays the post-claim unlink crash window without claiming the target twice', async () => {
		const candidate = 'exhibition-poster-11111111-1111-4111-8111-111111111111';
		const record = candidateRecord(candidate);
		const records = recoveryRecordStore([
			LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE,
			record,
		]);
		let unlinkFails = true;
		records.remove.mockImplementation(async (filePath) => {
			if (path.basename(filePath) === record && unlinkFails) {
				unlinkFails = false;
				throw new Error('record unlink failed');
			}
			records.records.delete(path.basename(filePath));
		});
		const lstat = vi.fn<NonNullable<FileSystem['lstat']>>()
			.mockResolvedValueOnce(oldRegularFile())
			.mockRejectedValueOnce(missing());
		const claim = vi.fn<NonNullable<FileSystem['claimAndRemoveFile']>>(
			async (_filePath, _quarantineDirectory, expected) => (
				expected === undefined ? 'missing' : 'removed'
			),
		);
		const fileSystem = recoveryFileSystem({ records, lstat, claimAndRemoveFile: claim });
		const scavenger = createUploadTempScavenger({
			fileSystem, legacyRootDirectory: ROOT, clock: { now: () => NOW }, logger: logger(),
		});

		await expect(scavenger.recoverOnStartup()).resolves.toMatchObject({ failed: 1 });
		expect(records.records.has(record)).toBe(true);
		await expect(scavenger.recoverOnStartup()).resolves.toMatchObject({ failed: 0 });
		expect(claim).toHaveBeenCalledTimes(2);
		expect(claim).toHaveBeenLastCalledWith(`${ROOT}/${candidate}`, DEDICATED);
		expect(records.records.has(record)).toBe(false);
	});

	it('continues cleanup of known pending candidates after discovery is blocked', async () => {
		const candidate = 'pcu-project-upload-11111111-1111-4111-8111-111111111111';
		const records = recoveryRecordStore([
			LEGACY_UPLOAD_RECOVERY_DISCOVERY_BLOCKED,
			candidateRecord(candidate),
		]);
		const rootEntries = vi.fn(async () => []);
		const claim = vi.fn<NonNullable<FileSystem['claimAndRemoveFile']>>(async () => 'removed');
		const fileSystem = recoveryFileSystem({ records, rootEntries, claimAndRemoveFile: claim });

		await createUploadTempScavenger({
			fileSystem, legacyRootDirectory: ROOT, clock: { now: () => NOW }, logger: logger(),
		}).recoverOnStartup();
		expect(rootEntries).not.toHaveBeenCalled();
		expect(claim).toHaveBeenCalledOnce();
		expect(records.records.has(candidateRecord(candidate))).toBe(false);
		expect(records.records.has(LEGACY_UPLOAD_RECOVERY_DISCOVERY_BLOCKED)).toBe(true);
	});

	it('ignores malformed, non-file, and path-escaping recovery records', async () => {
		const safe = 'pcu-project-upload-11111111-1111-4111-8111-111111111111';
		const records = recoveryRecordStore([LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE]);
		records.entries.mockImplementation(async () => [
			owned(LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE),
			owned(`${LEGACY_UPLOAD_RECOVERY_ATTEMPT_PREFIX}0`),
			owned(`${LEGACY_UPLOAD_RECOVERY_ATTEMPT_PREFIX}${MAX_LEGACY_UPLOAD_DISCOVERY_ATTEMPTS + 1}`),
			owned(`${LEGACY_UPLOAD_RECOVERY_CANDIDATE_PREFIX}not-safe`),
			owned(candidateRecord(safe), DEDICATED, false),
			{ ...owned(candidateRecord(safe)), path: `${ROOT}/${candidateRecord(safe)}` },
		]);
		const fileSystem = recoveryFileSystem({ records });
		await createUploadTempScavenger({
			fileSystem, legacyRootDirectory: ROOT, clock: { now: () => NOW }, logger: logger(),
		}).recoverOnStartup();

		expect(fileSystem.lstat).not.toHaveBeenCalled();
		expect(fileSystem.claimAndRemoveFile).not.toHaveBeenCalled();
		expect(records.remove).not.toHaveBeenCalled();
	});

	it('does not lose A pending candidate when empty discovery B pauses before complete', async () => {
		const candidate = 'pcu-project-upload-11111111-1111-4111-8111-111111111111';
		const records = recoveryRecordStore();
		let completeEntered!: () => void;
		const atComplete = new Promise<void>((resolve) => { completeEntered = resolve; });
		let releaseComplete!: () => void;
		const completeReleased = new Promise<void>((resolve) => { releaseComplete = resolve; });
		const createFromB = vi.fn<NonNullable<FileSystem['createFileExclusive']>>(
			async (filePath, contents) => {
				if (path.basename(filePath) === `${LEGACY_UPLOAD_RECOVERY_ATTEMPT_PREFIX}1.succeeded`) {
					completeEntered();
					await completeReleased;
				}
				return records.createFileExclusive(filePath, contents);
			},
		);
		const bRoot = vi.fn(async () => []);
		const aRoot = vi.fn(async () => [owned(candidate, ROOT)]);
		const bFileSystem = recoveryFileSystem({
			records,
			rootEntries: bRoot,
			createFileExclusive: createFromB,
			claimAndRemoveFile: async () => 'changed',
		});
		const aFileSystem = recoveryFileSystem({
			records, rootEntries: aRoot, claimAndRemoveFile: async () => 'changed',
		});
		const common = { legacyRootDirectory: ROOT, clock: { now: () => NOW }, logger: logger() };
		const b = createUploadTempScavenger({ fileSystem: bFileSystem, ...common });
		const a = createUploadTempScavenger({ fileSystem: aFileSystem, ...common });

		const bRecovery = b.recoverOnStartup();
		await atComplete;
		await a.recoverOnStartup();
		expect(records.records.has(candidateRecord(candidate))).toBe(true);
		releaseComplete();
		await bRecovery;
		expect(bRoot).toHaveBeenCalledOnce();
		expect(aRoot).toHaveBeenCalledOnce();
		expect(records.records.has(LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE)).toBe(true);
		expect(records.records.has(candidateRecord(candidate))).toBe(true);
	});

	it('never publishes complete while an earlier acquired attempt is unresolved', async () => {
		const candidate = 'pcu-project-upload-11111111-1111-4111-8111-111111111111';
		const records = recoveryRecordStore();
		const controller = new AbortController();
		const aRoot = vi.fn(async () => {
			controller.abort();
			return [owned(candidate, ROOT)];
		});
		const common = { legacyRootDirectory: ROOT, clock: { now: () => NOW }, logger: logger() };
		await createUploadTempScavenger({
			fileSystem: recoveryFileSystem({ records, rootEntries: aRoot }),
			...common,
		}).recoverOnStartup(controller.signal);

		const bRoot = vi.fn(async () => []);
		await createUploadTempScavenger({
			fileSystem: recoveryFileSystem({ records, rootEntries: bRoot }),
			...common,
		}).recoverOnStartup();
		expect(records.records.has(LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE)).toBe(false);

		const lastRoot = vi.fn(async () => { throw new Error('last attempt failed'); });
		await createUploadTempScavenger({
			fileSystem: recoveryFileSystem({ records, rootEntries: lastRoot }),
			...common,
		}).recoverOnStartup();
		expect(records.records.has(LEGACY_UPLOAD_RECOVERY_DISCOVERY_BLOCKED)).toBe(true);
		expect(records.records.has(LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE)).toBe(false);
		expect(aRoot).toHaveBeenCalledOnce();
		expect(bRoot).toHaveBeenCalledOnce();
		expect(lastRoot).not.toHaveBeenCalled();
	});

	it('retains pending when a file appears during atomic absence confirmation', async () => {
		const candidate = 'project-asset-11111111-1111-4111-8111-111111111111';
		const record = candidateRecord(candidate);
		const records = recoveryRecordStore([
			LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE,
			record,
		]);
		const claim = vi.fn<NonNullable<FileSystem['claimAndRemoveFile']>>(async () => 'changed');
		const fileSystem = recoveryFileSystem({
			records,
			lstat: async () => { throw missing(); },
			claimAndRemoveFile: claim,
		});
		await createUploadTempScavenger({
			fileSystem, legacyRootDirectory: ROOT, clock: { now: () => NOW }, logger: logger(),
		}).recoverOnStartup();

		expect(claim).toHaveBeenCalledWith(`${ROOT}/${candidate}`, DEDICATED);
		expect(records.records.has(record)).toBe(true);
	});

	it('does no destructive work after abort or failed attempt/candidate persistence', async () => {
		const abortedRecords = recoveryRecordStore();
		const controller = new AbortController();
		const abortingCreate = vi.fn<NonNullable<FileSystem['createFileExclusive']>>(
			async (filePath, contents) => {
				const result = await abortedRecords.createFileExclusive(filePath, contents);
				controller.abort();
				return result;
			},
		);
		const abortedRoot = vi.fn(async () => []);
		const abortedFs = recoveryFileSystem({
			records: abortedRecords, rootEntries: abortedRoot, createFileExclusive: abortingCreate,
		});
		await createUploadTempScavenger({
			fileSystem: abortedFs, legacyRootDirectory: ROOT,
			clock: { now: () => NOW }, logger: logger(),
		}).recoverOnStartup(controller.signal);
		expect(abortedRoot).not.toHaveBeenCalled();
		expect(abortedRecords.records.has(LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE)).toBe(false);

		const failedAttemptRoot = vi.fn(async () => []);
		const attemptRecords = recoveryRecordStore();
		const attemptFs = recoveryFileSystem({
			records: attemptRecords,
			rootEntries: failedAttemptRoot,
			createFileExclusive: async () => { throw new Error('disk full'); },
		});
		await createUploadTempScavenger({
			fileSystem: attemptFs, legacyRootDirectory: ROOT,
			clock: { now: () => NOW }, logger: logger(),
		}).recoverOnStartup();
		expect(failedAttemptRoot).not.toHaveBeenCalled();

		const candidate = 'project-asset-22222222-2222-4222-8222-222222222222';
		const snapshotRecords = recoveryRecordStore();
		const rootEntries = vi.fn(async () => [owned(candidate, ROOT)]);
		const lstat = vi.fn<NonNullable<FileSystem['lstat']>>(async () => oldRegularFile());
		const claim = vi.fn<NonNullable<FileSystem['claimAndRemoveFile']>>(async () => 'removed');
		const snapshotFs = recoveryFileSystem({
			records: snapshotRecords, rootEntries, lstat, claimAndRemoveFile: claim,
			createFileExclusive: async (filePath, contents) => {
				if (path.basename(filePath) === candidateRecord(candidate)) throw new Error('fsync failed');
				return snapshotRecords.createFileExclusive(filePath, contents);
			},
		});
		await createUploadTempScavenger({
			fileSystem: snapshotFs, legacyRootDirectory: ROOT,
			clock: { now: () => NOW }, logger: logger(),
		}).recoverOnStartup();
		expect(rootEntries).toHaveBeenCalledOnce();
		expect(lstat).not.toHaveBeenCalled();
		expect(claim).not.toHaveBeenCalled();
		expect(snapshotRecords.records.has(LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE)).toBe(false);
	});

	it.each([10, 10_000])(
		'keeps candidate metadata/delete work independent of %i unrelated root entries',
		async (unrelatedCount) => {
			const records = recoveryRecordStore();
			const candidates = Array.from({ length: 7 }, (_, index) => owned(
				`pcu-project-upload-${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, ROOT,
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
			const lstat = vi.fn<NonNullable<FileSystem['lstat']>>(
				async () => measured(oldRegularFile()),
			);
			const claim = vi.fn<NonNullable<FileSystem['claimAndRemoveFile']>>(
				async () => measured('removed'),
			);
			const fileSystem = recoveryFileSystem({
				records, rootEntries: async () => entries, lstat, claimAndRemoveFile: claim,
			});
			await createUploadTempScavenger({
				fileSystem, legacyRootDirectory: ROOT, clock: { now: () => NOW },
				logger: logger(), concurrency: 3,
			}).recoverOnStartup();
			expect(lstat).toHaveBeenCalledTimes(candidates.length);
			expect(claim).toHaveBeenCalledTimes(candidates.length);
			expect(peak).toBe(3);
		},
	);

	it('ignores the obsolete mutable JSON state file', async () => {
		const records = recoveryRecordStore(['.legacy-root-recovery-v2.json']);
		const rootEntries = vi.fn(async () => []);
		const fileSystem = recoveryFileSystem({ records, rootEntries });
		await createUploadTempScavenger({
			fileSystem, legacyRootDirectory: ROOT, clock: { now: () => NOW }, logger: logger(),
		}).recoverOnStartup();
		expect(rootEntries).toHaveBeenCalledOnce();
		expect(records.records.has('.legacy-root-recovery-v2.json')).toBe(true);
		expect(records.records.has(LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE)).toBe(true);
	});

	it('uses a bounded worker pool and coalesces overlapping routine sweeps', async () => {
		const entries = Array.from({ length: 31 }, (_, index) => owned(
			`project-asset-${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
		));
		let current = 0;
		let peak = 0;
		const stat = vi.fn<FileSystem['stat']>(async () => {
			current++;
			peak = Math.max(peak, current);
			await new Promise<void>((resolve) => setImmediate(resolve));
			current--;
			return { size: 1, lastModified: OLD };
		});
		const list = vi.fn(async () => entries);
		const scavenger = createUploadTempScavenger({
			fileSystem: {
				temporaryDirectory: () => DEDICATED, stat, remove: vi.fn(async () => {}),
				access: vi.fn(), mkdir: vi.fn(), listDirectoryEntries: list,
			},
			clock: { now: () => NOW }, logger: logger(), concurrency: 4,
		});
		const first = scavenger.sweep();
		expect(scavenger.sweep()).toBe(first);
		await first;
		expect(list).toHaveBeenCalledOnce();
		expect(stat).toHaveBeenCalledTimes(entries.length);
		expect(peak).toBe(4);
	});

	it('rechecks active ownership, treats ENOENT as benign, and isolates failures', async () => {
		const activeBase = `${DEDICATED}/pcu-project-upload-11111111-1111-4111-8111-111111111111`;
		const activeDerived = `${activeBase}.card-480.webp`;
		const missingStat = `${DEDICATED}/project-asset-22222222-2222-4222-8222-222222222222`;
		const missingRemove = `${DEDICATED}/project-asset-33333333-3333-4333-8333-333333333333`;
		const failedRemove = `${DEDICATED}/exhibition-poster-44444444-4444-4444-8444-444444444444.webp`;
		const registry = createActiveUploadTempRegistry();
		registry.register(activeBase);
		const stat = vi.fn<FileSystem['stat']>(async (filePath) => {
			if (filePath === missingStat) throw missing();
			return { size: 1, lastModified: OLD };
		});
		const remove = vi.fn<FileSystem['remove']>(async (filePath) => {
			if (filePath === missingRemove) throw missing();
			if (filePath === failedRemove) throw new Error('permission denied');
		});
		const scavenger = createUploadTempScavenger({
			fileSystem: {
				temporaryDirectory: () => DEDICATED, stat, remove, access: vi.fn(), mkdir: vi.fn(),
				listDirectoryEntries: vi.fn(async () => [
					owned(path.basename(activeDerived)), owned(path.basename(missingStat)),
					owned(path.basename(missingRemove)), owned(path.basename(failedRemove)),
				]),
			},
			active: registry, clock: { now: () => NOW }, logger: logger(),
		});

		await expect(scavenger.sweep()).resolves.toMatchObject({ removed: 0, failed: 1 });
		expect(stat).not.toHaveBeenCalledWith(activeDerived);
		registry.release(activeBase);
		await expect(scavenger.sweep()).resolves.toMatchObject({ removed: 1, failed: 1 });
		expect(remove).toHaveBeenCalledWith(activeDerived);
	});

	it('creates the dedicated view without I/O and forwards exclusive creation', async () => {
		const mkdir = vi.fn<FileSystem['mkdir']>(async () => {});
		const createFileExclusive = vi.fn<NonNullable<FileSystem['createFileExclusive']>>(
			async () => 'created',
		);
		const base = {
			temporaryDirectory: vi.fn(() => ROOT), stat: vi.fn(), access: vi.fn(), mkdir,
			createFileExclusive, rename: vi.fn(), remove: vi.fn(), readRange: vi.fn(),
			createReadStream: vi.fn(), createWriteStream: vi.fn(), listDirectoryEntries: vi.fn(),
		} as unknown as FileSystem;
		const view = createUploadTempFileSystem(base);
		expect(view.temporaryDirectory()).toBe(DEDICATED);
		expect(mkdir).not.toHaveBeenCalled();
		await view.mkdir(DEDICATED, { recursive: true });
		expect(mkdir).toHaveBeenCalledWith(DEDICATED, { recursive: true });
		await expect(view.createFileExclusive?.(`${DEDICATED}/record`)).resolves.toBe('created');
		expect(createFileExclusive).toHaveBeenCalledWith(`${DEDICATED}/record`, undefined);
	});
});
