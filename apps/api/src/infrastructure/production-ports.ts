import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import os from 'node:os';
import { OAuth2Client } from 'google-auth-library';
import type {
	Clock,
	AuthSessionStore,
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
import {
	getSiteSettings,
	reloadSiteSettings,
	updateSiteSettings,
	_invalidateCache,
} from '../shared/site-settings.js';
import { acquireUploadSlot, releaseUploadSlot } from '../shared/upload-limits.js';
import * as authRepository from '../modules/auth/repository.js';

export const systemClock: Clock = { now: () => new Date() };
export const cryptoIdGenerator: IdGenerator = { next: () => randomUUID() };

export const nodeScheduler: Scheduler = {
	every(intervalMs, task) {
		const timer = setInterval(() => void task(), intervalMs);
		return { cancel: () => clearInterval(timer) };
	},
};

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

export const nodeFileSystem: FileSystem = {
	temporaryDirectory: () => os.tmpdir(),
	stat: async (path) => fs.stat(path),
	access: async (path) => fs.access(path),
	mkdir: async (path, options) => {
		await fs.mkdir(path, options);
	},
	rename: async (from, to) => fs.rename(from, to),
	remove: async (path) => fs.unlink(path),
	createReadStream,
	createWriteStream,
};

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

export const cachedSettingsStore: SettingsStore = {
	get: getSiteSettings,
	update: updateSiteSettings,
	invalidate: _invalidateCache,
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

export const prismaHealth: DatabaseHealth = {
	async check() {
		try {
			await prisma.$queryRaw`SELECT 1`;
			return true;
		} catch {
			return false;
		}
	},
	close: () => prisma.$disconnect(),
};

export const prismaAuthSessions: AuthSessionStore = {
	find: authRepository.findSessionWithUser,
	touch: authRepository.touchSession,
	delete: authRepository.deleteSession,
};

// Keep the refresh operation reachable from the composition root without
// exposing the cache implementation to application services.
export async function warmSettingsStore(): Promise<void> {
	await reloadSiteSettings();
}
