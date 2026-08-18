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

export function createNodeFileSystem(): FileSystem {
	return {
	temporaryDirectory: () => os.tmpdir(),
	stat: async (path) => {
		const result = await fs.stat(path);
		return { size: result.size, lastModified: result.mtime };
	},
	access: async (path) => fs.access(path),
	mkdir: async (path, options) => {
		await fs.mkdir(path, options);
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
	rename: async (from, to) => fs.rename(from, to),
	remove: async (path) => fs.unlink(path),
	readRange: async (path, start, end) => {
		const handle = await fs.open(path, 'r');
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
