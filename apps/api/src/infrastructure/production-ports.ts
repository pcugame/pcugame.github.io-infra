import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import type {
	Clock,
	DatabaseHealth,
	FileSystem,
	GoogleTokenVerifier,
	IdGenerator,
	Lifecycle,
	Scheduler,
} from '../application/ports.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createLifecycle } from '../lib/lifecycle.js';
import {
	createCachedSettingsStore,
	createSiteSettingsRepository,
	type CachedSettingsStoreOptions,
} from '../shared/site-settings.js';
import { createUploadLimiter } from '../shared/upload-limits.js';

export function createSystemClock(): Clock {
	return { now: () => new Date() };
}

export function createCryptoIdGenerator(): IdGenerator {
	return { next: () => randomUUID() };
}

export function createNodeScheduler(): Scheduler {
	return {
		every(intervalMs, task) {
			const timer = setInterval(() => void task(), intervalMs);
			timer.unref();
			return { cancel: () => clearInterval(timer) };
		},
		delay: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	};
}

export function createNodeFileSystem(options: { uniqueId?: () => string } = {}): FileSystem {
	const uniqueId = options.uniqueId ?? randomUUID;

	async function syncDirectory(directory: string): Promise<void> {
		const directoryHandle = await fs.open(directory, 'r');
		try {
			await directoryHandle.sync();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
		} finally {
			await directoryHandle.close();
		}
	}

	async function reserveQuarantinePath(directory: string): Promise<string> {
		for (let attempt = 0; attempt < 16; attempt++) {
			const candidate = path.join(directory, `pcu-project-upload-${uniqueId()}`);
			let reservation: Awaited<ReturnType<typeof fs.open>> | undefined;
			try {
				reservation = await fs.open(candidate, 'wx', 0o600);
				await reservation.close();
				return candidate;
			} catch (error) {
				await reservation?.close().catch(() => undefined);
				if (reservation) await fs.unlink(candidate).catch(() => undefined);
				if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
				throw error;
			}
		}
		const error = new Error(
			'Could not allocate a unique upload quarantine path',
		) as NodeJS.ErrnoException;
		error.code = 'EEXIST';
		throw error;
	}
	return {
		temporaryDirectory: () => os.tmpdir(),
		stat: async (filePath) => {
			const result = await fs.stat(filePath);
			return { size: result.size, lastModified: result.mtime };
		},
		access: async (filePath) => fs.access(filePath),
		mkdir: async (directory, options) => {
			await fs.mkdir(directory, options);
		},
		ensurePrivateDirectory: async (directory) => {
			await fs.mkdir(directory, { recursive: true, mode: 0o700 });
			const initial = await fs.lstat(directory);
			const currentUid = process.getuid?.();
			if (currentUid === undefined) {
				throw new Error('Cannot verify upload temp directory ownership on this platform');
			}
			if (initial.isSymbolicLink() || !initial.isDirectory()) {
				throw new Error('Upload temp path must be a real directory, not a link or other entry');
			}
			if (initial.uid !== currentUid) {
				throw new Error('Upload temp directory must be owned by the current process user');
			}
			await fs.chmod(directory, 0o700);
			const verified = await fs.lstat(directory);
			if (verified.isSymbolicLink()
				|| !verified.isDirectory()
				|| verified.uid !== currentUid
				|| verified.dev !== initial.dev
				|| verified.ino !== initial.ino
				|| (verified.mode & 0o777) !== 0o700) {
				throw new Error('Upload temp directory changed or could not be secured');
			}
		},
		lstat: async (filePath) => {
			const result = await fs.lstat(filePath, { bigint: true });
			return {
				size: Number(result.size),
				lastModified: new Date(Number(result.mtimeMs)),
				isFile: result.isFile(),
				isSymbolicLink: result.isSymbolicLink(),
				identity: {
					device: result.dev.toString(),
					inode: result.ino.toString(),
				},
			};
		},
		createFileExclusive: async (filePath, contents = '') => {
			const directory = path.dirname(filePath);
			let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
			try {
				handle = await fs.open(filePath, 'wx', 0o600);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
				throw error;
			}
			try {
				if (contents.length > 0) await handle.writeFile(contents, 'utf8');
				await handle.sync();
				await handle.close();
				handle = undefined;
				await syncDirectory(directory);
			} catch (error) {
				await handle?.close().catch(() => undefined);
				throw error;
			}
			return 'created';
		},
		readTextFile: async (filePath) => fs.readFile(filePath, 'utf8'),
		claimAndRemoveFile: async (filePath, quarantineDirectory, expected) => {
			const quarantinePath = await reserveQuarantinePath(quarantineDirectory);
			const sourceDirectory = path.dirname(filePath);
			let sourceClaimed = false;
			try {
				try {
					await fs.rename(filePath, quarantinePath);
					sourceClaimed = true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
					throw error;
				}
				if (path.resolve(quarantineDirectory) !== path.resolve(sourceDirectory)) {
					await syncDirectory(quarantineDirectory);
				}
				await syncDirectory(sourceDirectory);

				const claimedMetadata = await fs.lstat(quarantinePath, { bigint: true });
				const matches = expected !== undefined
					&& claimedMetadata.isFile()
					&& !claimedMetadata.isSymbolicLink()
					&& claimedMetadata.dev.toString() === expected.identity.device
					&& claimedMetadata.ino.toString() === expected.identity.inode
					&& Number(claimedMetadata.size) === expected.size
					&& Number(claimedMetadata.mtimeMs) === expected.lastModifiedMs;
				if (!matches) {
					try {
						await fs.link(quarantinePath, filePath);
						await syncDirectory(sourceDirectory);
						await fs.unlink(quarantinePath);
						await syncDirectory(quarantineDirectory);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
						// A new source already exists. Keep the claimed file in the private,
						// closed-grammar quarantine for routine age-based recovery.
					}
					return 'changed';
				}
				await fs.unlink(quarantinePath);
				await syncDirectory(quarantineDirectory);
				return 'removed';
			} finally {
				if (!sourceClaimed) await fs.unlink(quarantinePath).catch(() => undefined);
			}
		},
		removeFileDurable: async (filePath) => {
			await fs.unlink(filePath);
			await syncDirectory(path.dirname(filePath));
		},
		rename: async (from, to) => fs.rename(from, to),
		remove: async (filePath) => fs.unlink(filePath),
		readRange: async (filePath, start, end) => {
			const handle = await fs.open(filePath, 'r');
			try {
				const buffer = Buffer.alloc(Math.max(0, end - start + 1));
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
				return buffer.subarray(0, bytesRead);
			} finally {
				await handle.close();
			}
		},
		createReadStream,
		createWriteStream,
		listDirectoryEntries: async (directory) => {
			const entries = await fs.readdir(directory, { withFileTypes: true });
			return entries.map((entry) => ({
				name: entry.name,
				path: path.join(directory, entry.name),
				isFile: entry.isFile(),
			}));
		},
	};
}

export function createGoogleTokenVerifier(client = new OAuth2Client()): GoogleTokenVerifier {
	return {
		async verify(credential, audiences) {
			const ticket = await client.verifyIdToken({ idToken: credential, audience: audiences });
			return ticket.getPayload();
		},
	};
}

export function createLifecyclePort(clock: Clock, scheduler: Scheduler): Lifecycle & { close(): void } {
	const lifecycle = createLifecycle({ clock, scheduler });
	return {
		state: lifecycle.getState,
		setState: lifecycle.setState,
		isAcceptingNewWork: lifecycle.isAcceptingNewWork,
		requestStarted: lifecycle.requestStarted,
		requestFinished: lifecycle.requestFinished,
		inFlight: lifecycle.getInFlight,
		waitForDrain: lifecycle.waitForDrain,
		close: lifecycle.close,
	};
}

export function createPrismaHealth(client: PrismaClient): DatabaseHealth {
	return {
		async check() {
			try {
				await client.$queryRaw`SELECT 1`;
				return true;
			} catch {
				return false;
			}
		},
	};
}

export function createPrismaSettingsStore(
	client: PrismaClient,
	logger: { warn(value: unknown, message?: string): void },
	options: Omit<CachedSettingsStoreOptions, 'logger'> = {},
) {
	return createCachedSettingsStore(createSiteSettingsRepository(client), {
		...options,
		logger: { warn: (value, message) => logger.warn(value, message) },
	});
}

export function createUploadLimiterPort(maxConcurrent: number) {
	return createUploadLimiter(() => maxConcurrent);
}
