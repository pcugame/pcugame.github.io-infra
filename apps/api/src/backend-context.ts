import type { FastifyPluginAsync } from 'fastify';
import type { Env } from './config/env.js';
import { env } from './config/env.js';
import { rootLogger } from './lib/logger.js';
import type {
	Clock,
	AuthSessionStore,
	AppLogger,
	BackgroundMaintenance,
	DatabaseHealth,
	FileSystem,
	GoogleTokenVerifier,
	IdGenerator,
	Lifecycle,
	ObjectStorage,
	Scheduler,
	SettingsStore,
	ShutdownResource,
	UploadLimiter,
} from './application/ports.js';
import {
	cachedSettingsStore,
	createGoogleTokenVerifier,
	cryptoIdGenerator,
	nodeFileSystem,
	nodeScheduler,
	objectStorage,
	prismaHealth,
	processLifecycle,
	processUploadLimiter,
	prismaAuthSessions,
	systemClock,
} from './infrastructure/production-ports.js';
import { prisma } from './lib/prisma.js';
import { authController } from './modules/auth/index.js';
import { devAuthController } from './modules/dev-auth/controller.js';
import { publicController } from './modules/public/index.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { meRoutes } from './modules/me/me.routes.js';
import { assetsController } from './modules/assets/index.js';
import { protectedDownloadLimiter } from './shared/protected-download-limiter.js';
import { orphanService } from './modules/orphan/runtime.js';
import { gameUploadService } from './modules/admin/game-upload/runtime.js';

export interface BackendRoutes {
	auth: FastifyPluginAsync;
	devAuth: FastifyPluginAsync;
	public: FastifyPluginAsync;
	admin: FastifyPluginAsync;
	me: FastifyPluginAsync;
	assets: FastifyPluginAsync;
}

/**
 * Explicit application composition boundary. Tests can replace any external
 * system without module mocking; production construction lives in one place.
 */
export interface BackendContext {
	config: Env;
	clock: Clock;
	logger: AppLogger;
	ids: IdGenerator;
	storage: ObjectStorage;
	fileSystem: FileSystem;
	googleTokens: GoogleTokenVerifier;
	scheduler: Scheduler;
	uploadLimiter: UploadLimiter;
	settings: SettingsStore;
	lifecycle: Lifecycle;
	databaseHealth: DatabaseHealth;
	authSessions: AuthSessionStore;
	maintenance: BackgroundMaintenance;
	shutdownResources: readonly ShutdownResource[];
	routes: BackendRoutes;
}

export function createProductionBackendContext(config: Env = env()): BackendContext {
	return {
		config,
		clock: systemClock,
		logger: rootLogger(),
		ids: cryptoIdGenerator,
		storage: objectStorage,
		fileSystem: nodeFileSystem,
		googleTokens: createGoogleTokenVerifier(),
		scheduler: nodeScheduler,
		uploadLimiter: processUploadLimiter,
		settings: cachedSettingsStore,
		lifecycle: processLifecycle,
		databaseHealth: prismaHealth,
		authSessions: prismaAuthSessions,
		maintenance: {
			async recoverStaleUploads() {
				await gameUploadService.sweepStaleCompletingSessions();
			},
			async purgeExpiredSessions(before) {
				const { count } = await prisma.authSession.deleteMany({
					where: { expiresAt: { lt: before } },
				});
				return count;
			},
			async reapOrphans() {
				await orphanService.runOrphanReaper();
			},
		},
		shutdownResources: [
			{ close: () => protectedDownloadLimiter.destroy() },
		],
		routes: {
			auth: authController,
			devAuth: devAuthController,
			public: publicController,
			admin: adminRoutes,
			me: meRoutes,
			assets: assetsController,
		},
	};
}
