import path from 'node:path';
import type { DirectoryEntry, FileSystem } from '../../application/ports.js';
import type { ActiveUploadTempRegistry } from '../../application/upload-ports.js';

const DEFAULT_GRACE_MS = 60 * 60 * 1000;
export const UPLOAD_TEMP_DIRECTORY_NAME = 'pcugame-upload';
export const LEGACY_UPLOAD_RECOVERY_MARKER = '.legacy-root-recovery-v1';
export const DEFAULT_UPLOAD_SCAVENGER_CONCURRENCY = 8;

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
 * Scan the dedicated upload directory routinely, and perform the legacy root
 * scan once per deployment directory version. The marker means "one best-effort
 * root enumeration was attempted", so failures do not retry forever or block
 * backend startup. An aborted attempt is deliberately not marked and may retry
 * after restart.
 */
export function createUploadTempScavenger(deps: {
	fileSystem: Pick<
		FileSystem,
		'temporaryDirectory' | 'stat' | 'remove' | 'access' | 'mkdir' | 'listDirectoryEntries'
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
		let total: UploadTempSweepResult = {
			scanned: 0,
			candidates: 0,
			removed: 0,
			failed: 0,
		};
		const markerPath = path.join(
			deps.fileSystem.temporaryDirectory(),
			LEGACY_UPLOAD_RECOVERY_MARKER,
		);
		let markerExists = false;
		try {
			await deps.fileSystem.access(markerPath);
			markerExists = true;
		} catch (error) {
			if (!isMissingFile(error)) {
				markerExists = true;
				deps.logger.error(
					{ error, markerPath },
					'Upload legacy recovery marker could not be inspected; root scan skipped',
				);
			}
		}

		if (!markerExists && !signal?.aborted && deps.legacyRootDirectory) {
			const legacy = await sweepDirectory(deps.legacyRootDirectory, signal);
			total = legacy;
			if (!signal?.aborted) {
				try {
					await deps.fileSystem.mkdir(markerPath);
				} catch (error) {
					deps.logger.error(
						{ error, markerPath },
						'Upload legacy recovery marker could not be recorded',
					);
				}
			}
		}

		if (!signal?.aborted) {
			const dedicated = await sweepDirectory(deps.fileSystem.temporaryDirectory(), signal);
			total = {
				scanned: total.scanned + dedicated.scanned,
				candidates: total.candidates + dedicated.candidates,
				removed: total.removed + dedicated.removed,
				failed: total.failed + dedicated.failed,
			};
		}
		return total;
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
