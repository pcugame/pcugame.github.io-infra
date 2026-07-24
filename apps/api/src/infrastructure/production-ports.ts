import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import { OAuth2Client } from 'google-auth-library';
import type {
	Clock,
	DatabaseHealth,
	FileSystem,
	GoogleTokenVerifier,
	IdGenerator,
	Lifecycle,
	ObjectStorage,
	Scheduler,
	SettingsStore,
	UploadLimiter,
} from '../application/ports.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';
import {
	abortMultipartUpload,
	completeMultipartUpload,
	createMultipartUpload,
	deleteObject,
	getObjectStream,
	getPresignedUrl,
	headObject,
	listObjectKeys,
	readObjectRange,
	uploadFile,
	uploadPart,
} from '../lib/storage.js';
import {
	getInFlight,
	getLifecycleState,
	incInFlight,
	decInFlight,
	isAcceptingNewWork,
	setLifecycleState,
	waitForDrain,
} from '../lib/lifecycle.js';
import { acquireUploadSlot, releaseUploadSlot } from '../shared/upload-limits.js';
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

export const systemClock: Clock = createSystemClock();
export const cryptoIdGenerator: IdGenerator = createCryptoIdGenerator();

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

export const nodeScheduler: Scheduler = createNodeScheduler();

export const objectStorage: ObjectStorage = {
	upload: uploadFile,
	presign: getPresignedUrl,
	delete: deleteObject,
	head: headObject,
	readRange: readObjectRange,
	stream: getObjectStream,
	listKeys: listObjectKeys,
	createMultipart: createMultipartUpload,
	uploadPart,
	completeMultipart: completeMultipartUpload,
	abortMultipart: abortMultipartUpload,
};

export function createNodeFileSystem(): FileSystem {
	return {
	temporaryDirectory: () => os.tmpdir(),
	stat: async (path) => fs.stat(path),
	access: async (path) => fs.access(path),
	mkdir: async (path, options) => {
		await fs.mkdir(path, options);
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
	};
}

export const nodeFileSystem: FileSystem = createNodeFileSystem();

export function createGoogleTokenVerifier(client = new OAuth2Client()): GoogleTokenVerifier {
	return {
		async verify(credential, audiences) {
			const ticket = await client.verifyIdToken({ idToken: credential, audience: audiences });
			return ticket.getPayload();
		},
	};
}

export const processUploadLimiter: UploadLimiter = {
	acquire: acquireUploadSlot,
	release: releaseUploadSlot,
};

export const processLifecycle: Lifecycle = {
	state: getLifecycleState,
	setState: setLifecycleState,
	isAcceptingNewWork,
	requestStarted: incInFlight,
	requestFinished: decInFlight,
	inFlight: getInFlight,
	waitForDrain,
};

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

export function createProcessUploadLimiter(maxConcurrent: number) {
	return createUploadLimiter(() => maxConcurrent);
}

export const prismaHealth: DatabaseHealth = {
	async check() {
		try {
			await prisma.$queryRaw`SELECT 1`;
			return true;
		} catch {
			return false;
		}
	},
};
