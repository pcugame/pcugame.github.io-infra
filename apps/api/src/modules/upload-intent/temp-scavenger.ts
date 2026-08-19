import path from 'node:path';
import type { DirectoryEntry, FileSystem } from '../../application/ports.js';
import type { ActiveUploadTempRegistry } from '../../application/upload-ports.js';

const DEFAULT_GRACE_MS = 60 * 60 * 1000;
export const UPLOAD_TEMP_DIRECTORY_NAME = 'pcugame-upload';
export const LEGACY_UPLOAD_RECOVERY_MARKER = '.legacy-root-recovery-v1';
const LEGACY_UPLOAD_RECOVERY_V2_PREFIX = '.legacy-root-recovery-v2';
export const LEGACY_UPLOAD_RECOVERY_ATTEMPT_PREFIX = `${LEGACY_UPLOAD_RECOVERY_V2_PREFIX}.attempt-`;
const LEGACY_UPLOAD_RECOVERY_ATTEMPT_SUCCEEDED_SUFFIX = '.succeeded';
const LEGACY_UPLOAD_RECOVERY_ATTEMPT_FAILED_SUFFIX = '.failed';
const LEGACY_UPLOAD_RECOVERY_ATTEMPT_SEALED_SUFFIX = '.sealed';
const LEGACY_UPLOAD_RECOVERY_TERMINAL_DECISION = `${LEGACY_UPLOAD_RECOVERY_V2_PREFIX}.discovery-terminal`;
export const LEGACY_UPLOAD_RECOVERY_CANDIDATE_PREFIX = `${LEGACY_UPLOAD_RECOVERY_V2_PREFIX}.candidate-`;
export const LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE = `${LEGACY_UPLOAD_RECOVERY_V2_PREFIX}.discovery-complete`;
export const LEGACY_UPLOAD_RECOVERY_DISCOVERY_BLOCKED = `${LEGACY_UPLOAD_RECOVERY_V2_PREFIX}.discovery-blocked`;
export const DEFAULT_UPLOAD_SCAVENGER_CONCURRENCY = 8;
export const MAX_LEGACY_UPLOAD_DISCOVERY_ATTEMPTS = 3;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DERIVED_SUFFIX_PATTERN = '(?:\\.webp|\\.card-480\\.webp|\\.display-960\\.webp|\\.playback\\.mp4)?';
const SAFE_UPLOAD_TEMP_NAME = new RegExp(
	`^(?:pcu-project-upload-|project-asset-|exhibition-poster-)${UUID}${DERIVED_SUFFIX_PATTERN}$`,
	'i',
);
const KNOWN_DERIVED_SUFFIXES = [
	'.card-480.webp',
	'.display-960.webp',
	'.playback.mp4',
	'.webp',
] as const;

export interface UploadTempSweepResult {
	scanned: number;
	candidates: number;
	removed: number;
	failed: number;
}

function isMissingFile(error: unknown): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& error.code === 'ENOENT';
}

function normalize(filePath: string): string {
	return path.resolve(filePath);
}

function basePathForKnownDerivative(filePath: string): string {
	const lower = filePath.toLowerCase();
	for (const suffix of KNOWN_DERIVED_SUFFIXES) {
		if (lower.endsWith(suffix)) return filePath.slice(0, -suffix.length);
	}
	return filePath;
}

/** Context-owned, in-memory protection for request files currently being written or processed. */
export function createActiveUploadTempRegistry(): ActiveUploadTempRegistry {
	const registrations = new Map<string, number>();
	return {
		register(temporaryPath) {
			const key = normalize(temporaryPath);
			registrations.set(key, (registrations.get(key) ?? 0) + 1);
		},
		release(temporaryPath) {
			const key = normalize(temporaryPath);
			const count = registrations.get(key);
			if (count === undefined) return;
			if (count <= 1) registrations.delete(key);
			else registrations.set(key, count - 1);
		},
		isActive(temporaryPath) {
			const key = normalize(temporaryPath);
			return registrations.has(key)
				|| registrations.has(normalize(basePathForKnownDerivative(key)));
		},
	};
}

/**
 * Preserve the process-wide temporaryDirectory contract while giving uploads a
 * context-owned namespace. Constructing this view performs no filesystem I/O.
 */
export function createUploadTempFileSystem(
	fileSystem: FileSystem,
	directoryName = UPLOAD_TEMP_DIRECTORY_NAME,
): FileSystem {
	const uploadDirectory = path.join(fileSystem.temporaryDirectory(), directoryName);
	return {
		temporaryDirectory: () => uploadDirectory,
		stat: (filePath) => fileSystem.stat(filePath),
		access: (filePath) => fileSystem.access(filePath),
		mkdir: (filePath, options) => fileSystem.mkdir(filePath, options),
		...(fileSystem.ensurePrivateDirectory
			? {
				ensurePrivateDirectory: (directory: string) => (
					fileSystem.ensurePrivateDirectory!(directory)
				),
			}
			: {}),
		...(fileSystem.lstat
			? { lstat: (filePath: string) => fileSystem.lstat!(filePath) }
			: {}),
		...(fileSystem.createFileExclusive
			? {
				createFileExclusive: (filePath: string, contents?: string) => (
					fileSystem.createFileExclusive!(filePath, contents)
				),
			}
			: {}),
		...(fileSystem.readTextFile
			? { readTextFile: (filePath: string) => fileSystem.readTextFile!(filePath) }
			: {}),
		...(fileSystem.claimAndRemoveFile
			? {
				claimAndRemoveFile: (filePath, quarantineDirectory, expected) => (
					fileSystem.claimAndRemoveFile!(filePath, quarantineDirectory, expected)
				),
			}
			: {}),
		...(fileSystem.removeFileDurable
			? { removeFileDurable: (filePath: string) => fileSystem.removeFileDurable!(filePath) }
			: {}),
		rename: (from, to) => fileSystem.rename(from, to),
		remove: (filePath) => fileSystem.remove(filePath),
		readRange: (filePath, start, end) => fileSystem.readRange(filePath, start, end),
		createReadStream: (filePath) => fileSystem.createReadStream(filePath),
		createWriteStream: (filePath) => fileSystem.createWriteStream(filePath),
		...(fileSystem.listDirectoryEntries
			? {
				listDirectoryEntries: (directory: string) => (
					fileSystem.listDirectoryEntries!(directory)
				),
			}
			: {}),
	};
}

function validCandidate(entry: DirectoryEntry, directory: string): boolean {
	if (!entry.isFile || !SAFE_UPLOAD_TEMP_NAME.test(entry.name)) return false;
	const expectedPath = path.join(directory, entry.name);
	return entry.path === expectedPath
		&& normalize(entry.path) === normalize(expectedPath)
		&& path.dirname(normalize(entry.path)) === normalize(directory);
}

/**
 * Scan the dedicated upload directory routinely. Startup compatibility recovery
 * snapshots legacy root candidates once, then retries only that finite snapshot.
 */
export function createUploadTempScavenger(deps: {
	fileSystem: Pick<
		FileSystem,
		'temporaryDirectory' | 'stat' | 'remove' | 'access' | 'mkdir'
		| 'listDirectoryEntries' | 'lstat' | 'createFileExclusive' | 'readTextFile'
		| 'claimAndRemoveFile' | 'removeFileDurable'
	>;
	legacyRootDirectory?: string;
	active?: Pick<ActiveUploadTempRegistry, 'isActive'>;
	clock: { now(): Date };
	logger: {
		info(context: Record<string, unknown>, message: string): void;
		error(context: Record<string, unknown>, message: string): void;
	};
	graceMs?: number;
	concurrency?: number;
}) {
	let inFlight: Promise<UploadTempSweepResult> | undefined;
	const concurrency = Math.max(
		1,
		Math.floor(deps.concurrency ?? DEFAULT_UPLOAD_SCAVENGER_CONCURRENCY),
	);
	interface LegacyRecoveryRecords {
		attempts: Set<number>;
		succeededAttempts: Set<number>;
		failedAttempts: Set<number>;
		sealedAttempts: Set<number>;
		candidates: Map<string, string>;
		discoveryComplete: boolean;
		discoveryBlocked: boolean;
	}

	function emptyResult(): UploadTempSweepResult {
		return { scanned: 0, candidates: 0, removed: 0, failed: 0 };
	}

	function addResults(
		left: UploadTempSweepResult,
		right: UploadTempSweepResult,
	): UploadTempSweepResult {
		return {
			scanned: left.scanned + right.scanned,
			candidates: left.candidates + right.candidates,
			removed: left.removed + right.removed,
			failed: left.failed + right.failed,
		};
	}

	function parseLegacyRecords(
		entries: DirectoryEntry[],
		directory: string,
	): LegacyRecoveryRecords {
		const records: LegacyRecoveryRecords = {
			attempts: new Set(),
			succeededAttempts: new Set(),
			failedAttempts: new Set(),
			sealedAttempts: new Set(),
			candidates: new Map(),
			discoveryComplete: false,
			discoveryBlocked: false,
		};
		const canonicalDirectory = normalize(directory);
		for (const entry of entries) {
			if (!entry.isFile
				|| entry.path !== path.join(directory, entry.name)
				|| path.dirname(normalize(entry.path)) !== canonicalDirectory) continue;
			if (entry.name === LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE) {
				records.discoveryComplete = true;
				continue;
			}
			if (entry.name === LEGACY_UPLOAD_RECOVERY_DISCOVERY_BLOCKED) {
				records.discoveryBlocked = true;
				continue;
			}
			if (entry.name.startsWith(LEGACY_UPLOAD_RECOVERY_ATTEMPT_PREFIX)) {
				let suffix = entry.name.slice(LEGACY_UPLOAD_RECOVERY_ATTEMPT_PREFIX.length);
				let outcome: 'succeeded' | 'failed' | 'sealed' | undefined;
				if (suffix.endsWith(LEGACY_UPLOAD_RECOVERY_ATTEMPT_SUCCEEDED_SUFFIX)) {
					suffix = suffix.slice(0, -LEGACY_UPLOAD_RECOVERY_ATTEMPT_SUCCEEDED_SUFFIX.length);
					outcome = 'succeeded';
				} else if (suffix.endsWith(LEGACY_UPLOAD_RECOVERY_ATTEMPT_FAILED_SUFFIX)) {
					suffix = suffix.slice(0, -LEGACY_UPLOAD_RECOVERY_ATTEMPT_FAILED_SUFFIX.length);
					outcome = 'failed';
				} else if (suffix.endsWith(LEGACY_UPLOAD_RECOVERY_ATTEMPT_SEALED_SUFFIX)) {
					suffix = suffix.slice(0, -LEGACY_UPLOAD_RECOVERY_ATTEMPT_SEALED_SUFFIX.length);
					outcome = 'sealed';
				}
				const attempt = Number(suffix);
				if (`${attempt}` === suffix
					&& attempt >= 1
					&& attempt <= MAX_LEGACY_UPLOAD_DISCOVERY_ATTEMPTS) {
					if (outcome === 'succeeded') records.succeededAttempts.add(attempt);
					else if (outcome === 'failed') records.failedAttempts.add(attempt);
					else if (outcome === 'sealed') records.sealedAttempts.add(attempt);
					else records.attempts.add(attempt);
				}
				continue;
			}
			if (entry.name.startsWith(LEGACY_UPLOAD_RECOVERY_CANDIDATE_PREFIX)) {
				const candidate = entry.name.slice(LEGACY_UPLOAD_RECOVERY_CANDIDATE_PREFIX.length);
				if (path.basename(candidate) === candidate && SAFE_UPLOAD_TEMP_NAME.test(candidate)) {
					records.candidates.set(candidate, entry.path);
				}
			}
		}
		for (const attempt of records.succeededAttempts) {
			if (!records.attempts.has(attempt)) records.succeededAttempts.delete(attempt);
		}
		for (const attempt of records.failedAttempts) {
			if (!records.attempts.has(attempt)) records.failedAttempts.delete(attempt);
		}
		for (const attempt of records.sealedAttempts) {
			if (!records.attempts.has(attempt)) records.sealedAttempts.delete(attempt);
		}
		return records;
	}

	async function sweepDirectory(
		directory: string,
		signal?: AbortSignal,
	): Promise<UploadTempSweepResult> {
		if (signal?.aborted || !deps.fileSystem.listDirectoryEntries) {
			return { scanned: 0, candidates: 0, removed: 0, failed: 0 };
		}
		let entries: DirectoryEntry[];
		try {
			entries = await deps.fileSystem.listDirectoryEntries(directory);
		} catch (error) {
			deps.logger.error(
				{ error, directory },
				'Upload temp scavenger failed to enumerate directory',
			);
			return { scanned: 0, candidates: 0, removed: 0, failed: 1 };
		}
		const candidates = entries.filter((entry) => validCandidate(entry, directory));
		const startedAt = deps.clock.now();
		const fence = startedAt.getTime() - (deps.graceMs ?? DEFAULT_GRACE_MS);

		let nextIndex = 0;
		let removed = 0;
		let failed = 0;

		async function worker(): Promise<void> {
			while (true) {
				const index = nextIndex++;
				const entry = candidates[index];
				if (!entry) return;
				if (signal?.aborted) return;
				if (deps.active?.isActive(entry.path)) continue;

				let lastModified: Date | undefined;
				try {
					if (signal?.aborted || deps.active?.isActive(entry.path)) continue;
					lastModified = (await deps.fileSystem.stat(entry.path)).lastModified;
				} catch (error) {
					if (isMissingFile(error)) continue;
					failed++;
					deps.logger.error(
						{ error, temporaryPath: entry.path },
						'Upload temp scavenger failed to inspect residue',
					);
					continue;
				}

				const modifiedAt = lastModified?.getTime();
				if (modifiedAt === undefined
					|| !Number.isFinite(modifiedAt)
					|| modifiedAt > fence
					|| modifiedAt > startedAt.getTime()) continue;
				if (signal?.aborted || deps.active?.isActive(entry.path)) continue;

				try {
					await deps.fileSystem.remove(entry.path);
					removed++;
				} catch (error) {
					if (isMissingFile(error)) continue;
					failed++;
					deps.logger.error(
						{ error, temporaryPath: entry.path },
						'Upload temp scavenger failed to remove residue',
					);
				}
			}
		}

		await Promise.all(
			Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()),
		);
		return { scanned: entries.length, candidates: candidates.length, removed, failed };
	}

	async function recoverOnStartup(signal?: AbortSignal): Promise<UploadTempSweepResult> {
		let total = emptyResult();
		const recoverySafety = { allowDedicatedSweep: true };
		if (deps.legacyRootDirectory && !signal?.aborted) {
			total = await recoverLegacyRoot(
				deps.legacyRootDirectory,
				recoverySafety,
				signal,
			);
		}
		if (!signal?.aborted && recoverySafety.allowDedicatedSweep) {
			const dedicated = await sweepDirectory(deps.fileSystem.temporaryDirectory(), signal);
			total = addResults(total, dedicated);
		}
		return total;
	}

	async function recoverLegacyRoot(
		legacyRootDirectory: string,
		recoverySafety: { allowDedicatedSweep: boolean },
		signal?: AbortSignal,
	): Promise<UploadTempSweepResult> {
		const {
			createFileExclusive,
			lstat,
			listDirectoryEntries,
			claimAndRemoveFile,
			removeFileDurable,
			readTextFile,
		} = deps.fileSystem;
		const recordDirectory = normalize(deps.fileSystem.temporaryDirectory());
		if (!createFileExclusive
			|| !lstat
			|| !listDirectoryEntries
			|| !claimAndRemoveFile
			|| !removeFileDurable
			|| !readTextFile) {
			recoverySafety.allowDedicatedSweep = false;
			deps.logger.error(
				{ recordDirectory },
				'Upload legacy recovery requires exclusive state records and no-follow metadata',
			);
			return { ...emptyResult(), failed: 1 };
		}

		async function readRecords(): Promise<LegacyRecoveryRecords | undefined> {
			try {
				const entries = await listDirectoryEntries!(recordDirectory);
				const records = parseLegacyRecords(entries, recordDirectory);
				const terminalEntry = entries.find((entry) => (
					entry.isFile
					&& entry.name === LEGACY_UPLOAD_RECOVERY_TERMINAL_DECISION
					&& entry.path === path.join(recordDirectory, entry.name)
				));
				if (terminalEntry) {
					const decision = await readTextFile!(terminalEntry.path);
					records.discoveryComplete = decision === 'complete\n';
					records.discoveryBlocked = !records.discoveryComplete;
					const markerName = records.discoveryComplete
						? LEGACY_UPLOAD_RECOVERY_DISCOVERY_COMPLETE
						: LEGACY_UPLOAD_RECOVERY_DISCOVERY_BLOCKED;
					if (!entries.some((entry) => entry.isFile && entry.name === markerName)) {
						const markerPath = path.join(recordDirectory, markerName);
						const result = await createFileExclusive!(markerPath);
						if (result === 'exists') {
							const metadata = await lstat!(markerPath);
							if (!metadata.isFile || metadata.isSymbolicLink) {
								throw new Error('Upload legacy recovery marker collision is not a regular file');
							}
						}
					}
				}
				return records;
			} catch (error) {
				recoverySafety.allowDedicatedSweep = false;
				deps.logger.error(
					{ error, recordDirectory },
					'Upload legacy recovery records could not be enumerated; recovery skipped',
				);
				return undefined;
			}
		}

		async function createRecord(
			recordName: string,
			contents = '',
		): Promise<'created' | 'exists'> {
			const recordPath = path.join(recordDirectory, recordName);
			const result = await createFileExclusive!(recordPath, contents);
			if (result === 'exists') {
				const metadata = await lstat!(recordPath);
				if (!metadata.isFile || metadata.isSymbolicLink) {
					throw new Error('Upload legacy recovery record collision is not a regular file');
				}
			}
			return result;
		}

		function attemptOutcomeName(attempt: number, succeeded: boolean): string {
			return `${LEGACY_UPLOAD_RECOVERY_ATTEMPT_PREFIX}${attempt}${
				succeeded
					? LEGACY_UPLOAD_RECOVERY_ATTEMPT_SUCCEEDED_SUFFIX
					: LEGACY_UPLOAD_RECOVERY_ATTEMPT_FAILED_SUFFIX
			}`;
		}

		function sealedAttemptName(attempt: number): string {
			return `${LEGACY_UPLOAD_RECOVERY_ATTEMPT_PREFIX}${attempt}${
				LEGACY_UPLOAD_RECOVERY_ATTEMPT_SEALED_SUFFIX
			}`;
		}

		async function sealUnusedAttempts(): Promise<LegacyRecoveryRecords | undefined> {
			let records = await readRecords();
			if (!records) return undefined;
			for (let attempt = 1; attempt <= MAX_LEGACY_UPLOAD_DISCOVERY_ATTEMPTS; attempt++) {
				if (records.attempts.has(attempt)) continue;
				const acquisition = await createRecord(
					`${LEGACY_UPLOAD_RECOVERY_ATTEMPT_PREFIX}${attempt}`,
				);
				if (acquisition === 'created') {
					await createRecord(sealedAttemptName(attempt));
				}
				records = await readRecords();
				if (!records) return undefined;
			}
			return records;
		}

		async function publishTerminal(allowBlockUnresolved = true): Promise<{
			records?: LegacyRecoveryRecords;
			failed: boolean;
		}> {
			let records = await readRecords();
			if (!records) return { failed: true };
			if (records.discoveryComplete || records.discoveryBlocked) {
				return { records, failed: false };
			}
			const finalized = new Set([
				...records.succeededAttempts,
				...records.failedAttempts,
				...records.sealedAttempts,
			]);
			const hasUnresolved = [...records.attempts].some((attempt) => !finalized.has(attempt));
			if (records.attempts.size < MAX_LEGACY_UPLOAD_DISCOVERY_ATTEMPTS) {
				return { records, failed: false };
			}
			if (hasUnresolved && !allowBlockUnresolved) {
				return { records, failed: false };
			}
			const decision = !hasUnresolved
				&& records.failedAttempts.size === 0
				&& records.succeededAttempts.size > 0
				? 'complete'
				: 'blocked';
			try {
				await createRecord(LEGACY_UPLOAD_RECOVERY_TERMINAL_DECISION, `${decision}\n`);
			} catch (error) {
				deps.logger.error(
					{ error, recordDirectory, decision },
					'Upload legacy recovery terminal record could not be created',
				);
				return { records, failed: true };
			}
			records = await readRecords();
			return records ? { records, failed: false } : { failed: true };
		}

		async function acquireAttempt(
			initial: LegacyRecoveryRecords,
		): Promise<{
			records: LegacyRecoveryRecords;
			attempt?: number;
			failed: boolean;
		}> {
			let records = initial;
			const occupied = new Set(records.attempts);
			for (let attempt = 1; attempt <= MAX_LEGACY_UPLOAD_DISCOVERY_ATTEMPTS; attempt++) {
				if (records.discoveryComplete || records.discoveryBlocked) {
					return { records, failed: false };
				}
				if (occupied.has(attempt)) continue;
				let acquisition: 'created' | 'exists';
				try {
					acquisition = await createRecord(
						`${LEGACY_UPLOAD_RECOVERY_ATTEMPT_PREFIX}${attempt}`,
					);
				} catch (error) {
					deps.logger.error(
						{ error, attempt, recordDirectory },
						'Upload legacy recovery attempt record could not be created',
					);
					return { records, failed: true };
				}
				if (acquisition === 'created') {
					records.attempts.add(attempt);
					const refreshed = await readRecords();
					if (!refreshed) return { records, failed: true };
					if (refreshed.discoveryComplete || refreshed.discoveryBlocked) {
						return { records: refreshed, failed: false };
					}
					return { records: refreshed, attempt, failed: false };
				}
				const refreshed = await readRecords();
				if (!refreshed) return { records, failed: true };
				records = refreshed;
				occupied.add(attempt);
				for (const existing of records.attempts) occupied.add(existing);
			}
			const terminal = await publishTerminal();
			return {
				records: terminal.records ?? records,
				failed: terminal.failed,
			};
		}

		let records = await readRecords();
		if (!records) return { ...emptyResult(), failed: 1 };
		let scanned = 0;
		if (!records.discoveryComplete && !records.discoveryBlocked) {
			const acquisition = await acquireAttempt(records);
			records = acquisition.records;
			if (acquisition.failed) return { ...emptyResult(), failed: 1 };
			if (acquisition.attempt !== undefined) {
				if (signal?.aborted) return emptyResult();
				let entries: DirectoryEntry[];
				try {
					entries = await listDirectoryEntries(legacyRootDirectory);
				} catch (error) {
					deps.logger.error(
						{ error, directory: legacyRootDirectory, attempt: acquisition.attempt },
						'Upload legacy recovery failed to enumerate shared root',
					);
					try {
						await createRecord(attemptOutcomeName(acquisition.attempt, false));
					} catch (outcomeError) {
						deps.logger.error(
							{ error: outcomeError, attempt: acquisition.attempt },
							'Upload legacy recovery failed attempt outcome could not be created',
						);
					}
					await publishTerminal();
					return { ...emptyResult(), failed: 1 };
				}
				scanned = entries.length;
				if (signal?.aborted) return { ...emptyResult(), scanned };
				const candidates = entries
					.filter((entry) => validCandidate(entry, legacyRootDirectory))
					.map((entry) => entry.name);
				let nextCandidate = 0;
				let persistenceFailures = 0;
				async function persistCandidateWorker(): Promise<void> {
					while (!signal?.aborted) {
						const candidate = candidates[nextCandidate++];
						if (!candidate) return;
						try {
							await createRecord(`${LEGACY_UPLOAD_RECOVERY_CANDIDATE_PREFIX}${candidate}`);
						} catch (error) {
							persistenceFailures++;
							deps.logger.error(
								{ error, candidate, recordDirectory },
								'Upload legacy recovery candidate record could not be created',
							);
						}
					}
				}
				await Promise.all(Array.from(
					{ length: Math.min(concurrency, candidates.length) },
					() => persistCandidateWorker(),
				));
				if (persistenceFailures > 0 || signal?.aborted) {
					if (!signal?.aborted) {
						try {
							await createRecord(attemptOutcomeName(acquisition.attempt, false));
						} catch (outcomeError) {
							deps.logger.error(
								{ error: outcomeError, attempt: acquisition.attempt },
								'Upload legacy recovery failed attempt outcome could not be created',
							);
						}
						await publishTerminal();
					}
					return {
						...emptyResult(),
						scanned,
						candidates: candidates.length,
						failed: persistenceFailures,
					};
				}
				try {
					await createRecord(attemptOutcomeName(acquisition.attempt, true));
					if (!await sealUnusedAttempts()) {
						return { ...emptyResult(), scanned, failed: 1 };
					}
				} catch (error) {
					deps.logger.error(
						{ error, recordDirectory, attempt: acquisition.attempt },
						'Upload legacy recovery succeeded attempt outcome could not be created',
					);
					return {
						...emptyResult(),
						scanned,
						candidates: candidates.length,
						failed: 1,
					};
				}
				const terminal = await publishTerminal(false);
				if (terminal.failed || !terminal.records) {
					return { ...emptyResult(), scanned, failed: 1 };
				}
				records = terminal.records;
			}
		}

		if (signal?.aborted) return { ...emptyResult(), scanned };
		if (!records.discoveryComplete && !records.discoveryBlocked) {
			return { ...emptyResult(), scanned };
		}
		const cleaned = await cleanupLegacyRecords(records, legacyRootDirectory, signal);
		return { ...cleaned, scanned };
	}

	async function cleanupLegacyRecords(
		records: LegacyRecoveryRecords,
		legacyRootDirectory: string,
		signal?: AbortSignal,
	): Promise<UploadTempSweepResult> {
		const candidates = [...records.candidates.entries()];
		let nextIndex = 0;
		let removed = 0;
		let failed = 0;
		const startedAt = deps.clock.now();
		const fence = startedAt.getTime() - (deps.graceMs ?? DEFAULT_GRACE_MS);

		async function consumeRecord(recordPath: string): Promise<boolean> {
			try {
				await deps.fileSystem.removeFileDurable!(recordPath);
				return true;
			} catch (error) {
				if (isMissingFile(error)) return true;
				failed++;
				deps.logger.error(
					{ error, recordPath },
					'Upload legacy recovery candidate record could not be durably removed',
				);
				return false;
			}
		}

		async function worker(): Promise<void> {
			while (true) {
				const record = candidates[nextIndex++];
				if (!record || signal?.aborted) return;
				const [basename, recordPath] = record;
				if (path.basename(basename) !== basename || !SAFE_UPLOAD_TEMP_NAME.test(basename)) {
					continue;
				}
				const candidatePath = path.join(legacyRootDirectory, basename);
				if (path.dirname(normalize(candidatePath)) !== normalize(legacyRootDirectory)
					|| deps.active?.isActive(candidatePath)) continue;

				let metadata: Awaited<ReturnType<NonNullable<FileSystem['lstat']>>>;
				try {
					metadata = await deps.fileSystem.lstat!(candidatePath);
				} catch (error) {
					if (isMissingFile(error)) {
						try {
							const absence = await deps.fileSystem.claimAndRemoveFile!(
								candidatePath,
								deps.fileSystem.temporaryDirectory(),
							);
							if (absence === 'missing') await consumeRecord(recordPath);
							else if (absence === 'changed') failed++;
						} catch (claimError) {
							if (!isMissingFile(claimError)) {
								failed++;
								deps.logger.error(
									{ error: claimError, temporaryPath: candidatePath },
									'Upload legacy recovery failed to confirm missing residue',
								);
							}
						}
						continue;
					}
					failed++;
					deps.logger.error(
						{ error, temporaryPath: candidatePath },
						'Upload legacy recovery failed to inspect residue',
					);
					continue;
				}
				const modifiedAt = metadata.lastModified?.getTime();
				if (!metadata.isFile
					|| metadata.isSymbolicLink
					|| modifiedAt === undefined
					|| !Number.isFinite(modifiedAt)
					|| modifiedAt > fence
					|| modifiedAt > startedAt.getTime()
					|| signal?.aborted
					|| deps.active?.isActive(candidatePath)
					|| path.basename(candidatePath) !== basename
					|| path.dirname(normalize(candidatePath)) !== normalize(legacyRootDirectory)) {
					continue;
				}
				try {
					const claim = await deps.fileSystem.claimAndRemoveFile!(
						candidatePath,
						deps.fileSystem.temporaryDirectory(),
						{
							size: metadata.size,
							lastModifiedMs: modifiedAt,
							identity: metadata.identity,
						},
					);
					if (claim === 'changed') {
						failed++;
						deps.logger.error(
							{ temporaryPath: candidatePath },
							'Upload legacy recovery residue changed before identity-bound removal',
						);
						continue;
					}
					if (!await consumeRecord(recordPath)) continue;
					if (claim === 'removed') removed++;
				} catch (error) {
					if (isMissingFile(error)) {
						await consumeRecord(recordPath);
						continue;
					}
					failed++;
					deps.logger.error(
						{ error, temporaryPath: candidatePath },
						'Upload legacy recovery failed to remove residue',
					);
				}
			}
		}

		await Promise.all(Array.from(
			{ length: Math.min(concurrency, candidates.length) },
			() => worker(),
		));
		return {
			scanned: 0,
			candidates: candidates.length,
			removed,
			failed,
		};
	}

	function singleFlight(
		work: () => Promise<UploadTempSweepResult>,
	): Promise<UploadTempSweepResult> {
		if (inFlight) return inFlight;
		const operation = (async () => {
			try {
				return await work();
			} finally {
				inFlight = undefined;
			}
		})();
		inFlight = operation;
		return operation;
	}

	return {
		sweep(signal?: AbortSignal): Promise<UploadTempSweepResult> {
			// Scheduler callers share one context signal. A pre-aborted ad-hoc call
			// must not occupy the slot that a following live caller needs.
			if (signal?.aborted) {
				return Promise.resolve({ scanned: 0, candidates: 0, removed: 0, failed: 0 });
			}
			return singleFlight(async () => {
				const result = await sweepDirectory(deps.fileSystem.temporaryDirectory(), signal);
				deps.logger.info({ ...result }, 'Upload temp scavenger sweep complete');
				return result;
			});
		},
		recoverOnStartup(signal?: AbortSignal): Promise<UploadTempSweepResult> {
			if (signal?.aborted) {
				return Promise.resolve({ scanned: 0, candidates: 0, removed: 0, failed: 0 });
			}
			return singleFlight(() => recoverOnStartup(signal));
		},
	};
}
