import type { FastifyPluginAsync } from 'fastify';
import type { S3Client } from '@aws-sdk/client-s3';
import type { PrismaClient } from './generated/prisma/client.js';
import type { Env } from './config/env.js';
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
	UploadLimiter,
} from './application/ports.js';
import {
	createCryptoIdGenerator,
	createGoogleTokenVerifier,
	createLifecyclePort,
	createNodeFileSystem,
	createNodeScheduler,
	createPrismaHealth,
	createPrismaSettingsStore,
	createSystemClock,
	createUploadLimiterPort,
} from './infrastructure/production-ports.js';
import { createPrismaClientForDatabase } from './lib/prisma-client.js';
import { createS3Client } from './lib/s3.js';
import { createObjectStorage } from './lib/storage.js';
import { createRootLogger } from './lib/logger.js';
import { createProtectedDownloadLimiter } from './shared/protected-download-limiter.js';
import type { DownloadRateLimiter } from './shared/download-rate-limit.js';
import {
	createExportProgressStore,
	type ExportProgressStore,
} from './modules/admin/export/service.js';
import {
	createAssetsBannedProductionGraph,
	type AssetsBannedProductionGraph,
} from './modules/assets/composition.js';
import {
	createAuthProductionGraph,
	type AuthProductionRepository,
	type AuthProductionGraph,
} from './modules/auth/composition.js';
import { createAuthRepository } from './modules/auth/repository.js';
import {
	createPublicProductionGraph,
	type PublicProductionRepository,
	type PublicProductionGraph,
} from './modules/public/composition.js';
import { createPublicRepository } from './modules/public/repository.js';
import {
	createProjectMemberSettingsProductionGraph,
	type ProjectMemberSettingsProductionGraph,
} from './modules/admin/project-member-settings.composition.js';
import {
	createYearProductionGraph,
	type YearProductionGraph,
} from './modules/admin/year/composition.js';
import {
	createImportExportProductionGraph,
	type ExportRepository,
	type ImportExportProductionGraph,
} from './modules/admin/import-export.composition.js';
import { createImportRepository } from './modules/admin/import/repository.js';
import type { ImportRepository } from './modules/admin/import/service.js';
import { createExportRepository } from './modules/admin/export/repository.js';
import {
	createProjectMultipartProductionGraph,
	type ProjectMultipartProductionGraph,
} from './modules/admin/project-multipart.composition.js';
import {
	createGameUploadProductionGraph,
	type GameUploadProductionGraph,
} from './modules/admin/game-upload/composition.js';
import type { ProjectUploadProcessing } from './modules/admin/project/project-upload.adapter.js';
import { createNodeProjectUploadProcessing } from './infrastructure/project-upload-processing.js';
import { createMultipartRequestHasher } from './infrastructure/multipart-request-hasher.js';
import { createUploadTempScavenger } from './modules/upload-intent/temp-scavenger.js';
import {
	createUploadLifecycleMetrics,
	type UploadLifecycleMetrics,
} from './lib/upload-lifecycle-metrics.js';
import {
	createProductionUploadLifecycleRuntime,
	type UploadLifecycleRuntime,
} from './modules/upload-lifecycle/runtime.js';
import { createAssetsRepository } from './modules/assets/repository.js';
import { createBannedIpRepository } from './modules/admin/banned-ip/repository.js';
import { createProjectAccessRepository } from './modules/admin/project-access.repository.js';
import { createProjectAccessService } from './modules/admin/project-access.service.js';
import { createProjectCrudRepository } from './modules/admin/project/crud.repository.js';
import { createMemberRepository } from './modules/admin/member/repository.js';
import { createExhibitionRepository } from './modules/admin/year/repository.js';
import type { AssetsServiceDependencies } from './modules/assets/service.js';
import type { BannedIpServiceDependencies } from './modules/admin/banned-ip/service.js';
import type { ProjectAccessRepository } from './modules/admin/project-access.service.js';
import type { ProjectApplicationRepository } from './modules/admin/project/ports.js';
import type { MemberServiceDependencies } from './modules/admin/member/service.js';
import type { ExhibitionRepository } from './modules/admin/year/ports.js';

/**
 * Complete persistence boundary consumed by the production composition graph.
 * Production builds it from one Prisma client; composition/lifecycle tests inject
 * scripted domain ports and never need to construct or emulate Prisma delegates.
 */
export interface BackendPersistencePorts {
	databaseHealth: DatabaseHealth;
	authRepository: AuthProductionRepository;
	publicRepository: PublicProductionRepository;
	projectAccessRepository: ProjectAccessRepository;
	projectRepository: ProjectApplicationRepository;
	memberRepository: MemberServiceDependencies['repository'];
	exhibitionRepository: ExhibitionRepository;
	assetsRepository: AssetsServiceDependencies['repository'] & {
		findAllBannedIps(): Promise<{ ip: string }[]>;
	};
	bannedIpRepository: BannedIpServiceDependencies['repository'];
	importRepository: ImportRepository;
	exportRepository: ExportRepository;
}

export interface BackendRoutes {
	auth: FastifyPluginAsync;
	devAuth: FastifyPluginAsync;
	public: FastifyPluginAsync;
	admin: FastifyPluginAsync;
	me: FastifyPluginAsync;
	assets: FastifyPluginAsync;
}

export type ResourceOwnership = 'owned' | 'borrowed';

/**
 * An externally supplied resource must declare who owns its lifetime. Borrowed
 * resources are observable through the context but are never started or closed
 * by it; owned resources join the same reverse-order lifecycle as factory output.
 */
export type ResourceLease<T> =
	| {
		value: T;
		ownership: 'borrowed';
	}
	| {
		value: T;
		ownership: 'owned';
		start?: () => void | Promise<void>;
		close: () => void | Promise<void>;
	};

export interface BackendResourceOwnership {
	name: string;
	ownership: ResourceOwnership;
}

interface RegisteredResource extends BackendResourceOwnership {
	start?: () => void | Promise<void>;
	close?: () => void | Promise<void>;
}

class BackendResourceOwner {
	private readonly registered: RegisteredResource[] = [];
	private closingRequested = false;
	private startWork: Promise<void> | undefined;
	private startPromise: Promise<void> | undefined;
	private closePromise: Promise<void> | undefined;

	register<T>(name: string, lease: ResourceLease<T>): T {
		if (this.startPromise || this.closePromise) {
			throw new Error(`Cannot register ${name} after the BackendContext lifecycle began`);
		}
		this.registered.push({
			name,
			ownership: lease.ownership,
			start: lease.ownership === 'owned' ? lease.start : undefined,
			close: lease.ownership === 'owned' ? lease.close : undefined,
		});
		return lease.value;
	}

	ownership(): readonly BackendResourceOwnership[] {
		return this.registered.map(({ name, ownership }) => ({ name, ownership }));
	}

	start(): Promise<void> {
		if (this.closePromise) return Promise.reject(new Error('BackendContext is closed'));
		this.startWork ??= (async () => {
			for (const resource of this.registered) {
				if (this.closingRequested) throw new Error('BackendContext start aborted by close');
				if (resource.ownership === 'owned') await resource.start?.();
				if (this.closingRequested) throw new Error('BackendContext start aborted by close');
			}
		})();
		this.startPromise ??= this.startWork.catch(async (error) => {
			await this.close().catch(() => undefined);
			throw error;
		});
		return this.startPromise;
	}

	close(): Promise<void> {
		this.closingRequested = true;
		this.closePromise ??= (async () => {
			const closeTimeoutMs = 5_000;
			async function settleWithin(work: Promise<unknown>, label: string): Promise<void> {
				let timer: NodeJS.Timeout | undefined;
				try {
					await Promise.race([
						work,
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(
								() => reject(new Error(`Timed out closing ${label}`)),
								closeTimeoutMs,
							);
							timer.unref();
						}),
					]);
				} finally {
					if (timer) clearTimeout(timer);
				}
			}

			let firstError: unknown;
			if (this.startWork) {
				try {
					await settleWithin(this.startWork.catch(() => undefined), 'context startup');
				} catch (error) {
					firstError ??= error;
				}
			}
			for (const resource of [...this.registered].reverse()) {
				if (resource.ownership !== 'owned') continue;
				try {
					await settleWithin(Promise.resolve().then(() => resource.close?.()), resource.name);
				} catch (error) {
					firstError ??= error;
				}
			}
			if (firstError !== undefined) throw firstError;
		})();
		return this.closePromise;
	}
}

/** Explicit application composition and resource lifetime boundary. */
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
	protectedDownloads: DownloadRateLimiter;
	settings: SettingsStore;
	exportProgress: ExportProgressStore;
	uploadLifecycleMetrics: UploadLifecycleMetrics;
	uploadLifecycle: UploadLifecycleRuntime;
	lifecycle: Lifecycle;
	databaseHealth: DatabaseHealth;
	authSessions: AuthSessionStore;
	maintenance: BackgroundMaintenance;
	routes: BackendRoutes;
	resourceOwnership: readonly BackendResourceOwnership[];
	start(): Promise<void>;
	close(): Promise<void>;
}

type MaybePromise<T> = T | Promise<T>;

export interface ProductionResourceFactories {
	logger(config: Env): MaybePromise<AppLogger>;
	clock(config: Env): MaybePromise<Clock>;
	ids(config: Env): MaybePromise<IdGenerator>;
	scheduler(config: Env): MaybePromise<Scheduler>;
	fileSystem(config: Env): MaybePromise<FileSystem>;
	projectUploadProcessing(
		fileSystem: FileSystem,
		logger: AppLogger,
		config: Env,
	): MaybePromise<ProjectUploadProcessing>;
	googleTokens(config: Env): MaybePromise<GoogleTokenVerifier>;
	prisma(config: Env): MaybePromise<PrismaClient>;
	s3(config: Env): MaybePromise<S3Client>;
	storage(client: S3Client, config: Env): MaybePromise<ObjectStorage>;
	settings(
		client: PrismaClient,
		logger: AppLogger,
		config: Env,
	): MaybePromise<SettingsStore & { warmup?(): Promise<unknown>; close(): void }>;
	uploadLimiter(config: Env): MaybePromise<UploadLimiter & { close(): void }>;
	lifecycle(clock: Clock, scheduler: Scheduler, config: Env): MaybePromise<Lifecycle & { close(): void }>;
	protectedDownloads(clock: Clock, scheduler: Scheduler, config: Env): MaybePromise<DownloadRateLimiter>;
	exportProgress(config: Env): MaybePromise<ExportProgressStore>;
	routes(
		config: Env,
		assetsBanned: AssetsBannedProductionGraph,
		auth: AuthProductionGraph,
		publicGraph: PublicProductionGraph,
		projectMemberSettings: ProjectMemberSettingsProductionGraph,
		year: YearProductionGraph,
		importExport: ImportExportProductionGraph,
		projectMultipart: ProjectMultipartProductionGraph,
		gameUpload: GameUploadProductionGraph,
	): MaybePromise<BackendRoutes>;
}

export interface ProductionResourceOverrides {
	logger: ResourceLease<AppLogger>;
	clock: ResourceLease<Clock>;
	ids: ResourceLease<IdGenerator>;
	scheduler: ResourceLease<Scheduler>;
	fileSystem: ResourceLease<FileSystem>;
	googleTokens: ResourceLease<GoogleTokenVerifier>;
	prisma: ResourceLease<PrismaClient>;
	s3: ResourceLease<S3Client>;
	storage: ResourceLease<ObjectStorage>;
	settings: ResourceLease<SettingsStore>;
	uploadLimiter: ResourceLease<UploadLimiter>;
	lifecycle: ResourceLease<Lifecycle>;
	protectedDownloads: ResourceLease<DownloadRateLimiter>;
	exportProgress: ResourceLease<ExportProgressStore>;
	uploadLifecycle: ResourceLease<UploadLifecycleRuntime>;
}

export interface CreateProductionBackendContextOptions {
	/** Construction hooks are test seams; their output is owned by the context. */
	factories?: Partial<ProductionResourceFactories>;
	/** Supplied live resources must state whether the context owns them. */
	resources?: Partial<ProductionResourceOverrides>;
	/** Complete non-Prisma persistence seam for composition and lifecycle tests. */
	persistence?: BackendPersistencePorts;
	routes?: BackendRoutes;
}

const defaultFactories: ProductionResourceFactories = {
	logger: (config) => createRootLogger(config),
	clock: () => createSystemClock(),
	ids: () => createCryptoIdGenerator(),
	scheduler: () => createNodeScheduler(),
	fileSystem: () => createNodeFileSystem(),
	projectUploadProcessing: (fileSystem, logger) => (
		createNodeProjectUploadProcessing(fileSystem, logger)
	),
	googleTokens: () => createGoogleTokenVerifier(),
	prisma: (config) => createPrismaClientForDatabase(config.DATABASE_URL, {
		log: config.NODE_ENV === 'development'
			? [
				{ emit: 'event', level: 'query' },
				{ emit: 'stdout', level: 'error' },
			]
			: [{ emit: 'stdout', level: 'error' }],
	}),
	s3: (config) => createS3Client(config),
	storage: (client, config) => createObjectStorage(client, {
		defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC,
	}),
	settings: (client, logger) => createPrismaSettingsStore(client, logger),
	uploadLimiter: (config) => createUploadLimiterPort(config.UPLOAD_MAX_CONCURRENT),
	lifecycle: (clock, scheduler) => createLifecyclePort(clock, scheduler),
	protectedDownloads: (clock, scheduler) => createProtectedDownloadLimiter({ clock, scheduler }),
	exportProgress: () => createExportProgressStore(),
	routes: loadProductionRoutes,
};

async function loadProductionRoutes(
	_config: Env,
	assetsBanned: AssetsBannedProductionGraph,
	auth: AuthProductionGraph,
	publicGraph: PublicProductionGraph,
	projectMemberSettings: ProjectMemberSettingsProductionGraph,
	year: YearProductionGraph,
	importExport: ImportExportProductionGraph,
	projectMultipart: ProjectMultipartProductionGraph,
	gameUpload: GameUploadProductionGraph,
): Promise<BackendRoutes> {
	const admin = await import('./modules/admin/admin.routes.js');
	return {
		auth: auth.authController,
		devAuth: auth.devAuthController,
		public: publicGraph.controller,
		admin: admin.createAdminRoutes({
			...projectMemberSettings,
			...year,
			...importExport,
			bannedIpController: assetsBanned.bannedIpController,
			projectMultipartController: projectMultipart.projectMultipartController,
			gameUploadController: gameUpload.controller,
		}),
		me: projectMultipart.meController,
		assets: assetsBanned.assetsController,
	};
}

function owned<T>(value: T, close?: () => void | Promise<void>, start?: () => void | Promise<void>): ResourceLease<T> {
	return { value, ownership: 'owned', close: close ?? (() => {}), start };
}

export function createMaintenanceSchedule(
	scheduler: Scheduler,
	clock: Clock,
	maintenance: BackgroundMaintenance,
	logger: AppLogger,
): { start(): void; close(): Promise<void> } {
	const tasks: Array<{ cancel(): void }> = [];
	const inFlight = new Set<Promise<void>>();
	let started = false;
	let closed = false;
	let closePromise: Promise<void> | undefined;
	const abortController = new AbortController();

	async function runTracked(work: () => Promise<void>): Promise<void> {
		const operation = work();
		inFlight.add(operation);
		try {
			await operation;
		} finally {
			inFlight.delete(operation);
		}
	}

	return {
		start() {
			if (started) return;
			if (closed) throw new Error('Maintenance schedule is closed');
			started = true;
			tasks.push(scheduler.every(60 * 60 * 1000, () => runTracked(async () => {
				try {
					const count = await maintenance.purgeExpiredSessions(
						clock.now(),
						abortController.signal,
					);
					if (count > 0) logger.info({ count }, 'Purged expired sessions');
				} catch (error) {
					logger.error(error, 'Failed to purge expired sessions');
				}
			})));
			tasks.push(scheduler.every(60 * 1000, () => runTracked(async () => {
				try {
					await maintenance.reapOrphans(abortController.signal);
				} catch (error) {
					logger.error(error, 'Orphan reaper iteration crashed');
				}
			})));
			tasks.push(scheduler.every(60 * 1000, () => runTracked(async () => {
				try {
					await maintenance.recoverStaleUploads(abortController.signal);
				} catch (error) {
					logger.error(error, 'Upload lifecycle maintenance iteration crashed');
				}
			})));
		},
		close() {
			closePromise ??= (async () => {
				closed = true;
				abortController.abort(new Error('Maintenance schedule is closing'));
				for (const task of [...tasks].reverse()) task.cancel();
				tasks.length = 0;
				await Promise.allSettled([...inFlight]);
			})();
			return closePromise;
		},
	};
}

/**
 * Build one production resource graph from explicit config. No DB/S3 operation,
 * timer, maintenance task, or signal listener starts until context.start().
 */
export async function createProductionBackendContext(
	config: Env,
	options: CreateProductionBackendContextOptions = {},
): Promise<BackendContext> {
	const owner = new BackendResourceOwner();
	const factories = { ...defaultFactories, ...options.factories };
	const supplied = options.resources ?? {};

	async function resource<T>(
		name: keyof ProductionResourceOverrides,
		create: () => MaybePromise<T>,
		close?: (value: T) => void | Promise<void>,
		start?: (value: T) => void | Promise<void>,
	): Promise<T> {
		const external = supplied[name] as ResourceLease<T> | undefined;
		if (external) return owner.register(name, external);
		const value = await create();
		return owner.register(name, owned(
			value,
			close ? () => close(value) : undefined,
			start ? () => start(value) : undefined,
		));
	}

	try {
		const logger = await resource('logger', () => factories.logger(config));
		const uploadLifecycleMetrics = createUploadLifecycleMetrics();
		const clock = await resource('clock', () => factories.clock(config));
		const ids = await resource('ids', () => factories.ids(config));
		const scheduler = await resource('scheduler', () => factories.scheduler(config));
		const fileSystem = await resource('fileSystem', () => factories.fileSystem(config));
		const projectUploads = await factories.projectUploadProcessing(
			fileSystem,
			logger,
			config,
		);
		const googleTokens = await resource('googleTokens', () => factories.googleTokens(config));
		const prisma = options.persistence
			? undefined
			: await resource(
				'prisma',
				() => factories.prisma(config),
				(client) => client.$disconnect(),
			);
		const s3 = await resource('s3', () => factories.s3(config), (client) => client.destroy());
		const storage = await resource('storage', () => factories.storage(s3, config));
		const uploadLifecycle = await resource(
			'uploadLifecycle',
			() => {
				if (!prisma) {
					throw new Error(
						'An explicit uploadLifecycle resource is required with injected persistence ports',
					);
				}
				return createProductionUploadLifecycleRuntime({
					config,
					prisma,
					storage,
					clock,
					ids,
					logger,
					metrics: uploadLifecycleMetrics,
				});
			},
			(runtime) => runtime.close(),
			(runtime) => runtime.start(),
		);
		const settings = await resource(
			'settings',
			() => {
				if (!prisma) {
					throw new Error(
						'An explicit settings resource is required with injected persistence ports',
					);
				}
				return factories.settings(prisma, logger, config);
			},
			(store) => 'close' in store && typeof store.close === 'function' ? store.close() : undefined,
			async (store) => {
				if ('warmup' in store && typeof store.warmup === 'function') await store.warmup();
			},
		);
		const uploadLimiter = await resource(
			'uploadLimiter',
			() => factories.uploadLimiter(config),
			(limiter) => 'close' in limiter && typeof limiter.close === 'function' ? limiter.close() : undefined,
		);
		const lifecycle = await resource(
			'lifecycle',
			() => factories.lifecycle(clock, scheduler, config),
			(value) => 'close' in value && typeof value.close === 'function' ? value.close() : undefined,
		);
		const protectedDownloads = await resource(
			'protectedDownloads',
			() => factories.protectedDownloads(clock, scheduler, config),
			(limiter) => limiter.close(),
			(limiter) => limiter.start(),
		);
		const exportProgress = await resource(
			'exportProgress',
			() => factories.exportProgress(config),
			(progress) => progress.close(),
		);
		const persistence: BackendPersistencePorts = options.persistence ?? (() => {
			if (!prisma) throw new Error('Prisma persistence was not initialized');
			return {
				databaseHealth: createPrismaHealth(prisma),
				authRepository: createAuthRepository(prisma),
				publicRepository: createPublicRepository(prisma),
				projectAccessRepository: createProjectAccessRepository(prisma),
				projectRepository: createProjectCrudRepository(prisma),
				memberRepository: createMemberRepository(prisma),
				exhibitionRepository: createExhibitionRepository(prisma),
				assetsRepository: createAssetsRepository(prisma),
				bannedIpRepository: createBannedIpRepository(prisma),
				importRepository: createImportRepository(prisma),
				exportRepository: createExportRepository(prisma),
			};
		})();
		const databaseHealth = persistence.databaseHealth;
		const auth = createAuthProductionGraph({
			config,
			repository: persistence.authRepository,
			googleTokens,
			clock,
			ids,
			logger,
		});
		const publicGraph = createPublicProductionGraph({
			config,
			repository: persistence.publicRepository,
			storage,
		});
		const projectAccessRepository = persistence.projectAccessRepository;
		const projectAccess = createProjectAccessService(projectAccessRepository);
		const projectRepository = persistence.projectRepository;
		const projectMemberSettings = createProjectMemberSettingsProductionGraph({
			config,
			projectAccess,
			projectExists: async (projectId) => (
				await projectAccessRepository.findProject(projectId) !== null
			),
			projectRepository,
			memberRepository: persistence.memberRepository,
			storage,
			settings,
			logger,
			clock,
			uploadLifecycle,
		});
		const year = createYearProductionGraph({
			config,
			repository: persistence.exhibitionRepository,
			storage,
			fileSystem,
			settings,
			uploadLimiter,
			logger,
			clock,
			ids,
			uploadLifecycle,
		});
		let assetsBanned: AssetsBannedProductionGraph | undefined;
		if (!options.routes) {
			const graph = createAssetsBannedProductionGraph({
				config,
				assetsRepository: persistence.assetsRepository,
				bannedIpRepository: persistence.bannedIpRepository,
				projectAccess,
				storage,
				downloadLimiter: protectedDownloads,
				logger,
				clock,
				uploadLifecycle,
			});
			assetsBanned = graph;
			owner.register('assetsBannedWarmup', owned(
				graph.warmup,
				undefined,
				() => graph.warmup.start(),
			));
		}
		const importExport = createImportExportProductionGraph({
			config,
			importRepository: persistence.importRepository,
			exportRepository: persistence.exportRepository,
			storage,
			fileSystem,
			exportProgress,
			clock,
			ids,
			logger,
		});
		owner.register('importExport', owned(
			importExport,
			() => importExport.close(),
		));
		const projectMultipart = createProjectMultipartProductionGraph({
			config,
			storage,
			fileSystem,
			settings,
			uploadLimiter,
			logger,
			clock,
			ids,
			processing: projectUploads,
			requestHasher: createMultipartRequestHasher(fileSystem),
			uploadLifecycle,
			access: projectMemberSettings.projectAccess,
			repository: projectMemberSettings.projectRepository,
		});
		const gameUpload = createGameUploadProductionGraph({
			config,
			storage,
			fileSystem,
			settings,
			uploadLimiter,
			lifecycle,
			clock,
			ids,
			logger,
			access: projectMemberSettings.projectAccess,
			uploadLifecycle,
		});
		const uploadTempScavenger = createUploadTempScavenger({
			fileSystem,
			clock,
			logger,
		});
		owner.register('gameUploadWorkflow', owned(
			gameUpload,
			() => gameUpload.close(),
			() => gameUpload.recoverStaleUploads(),
		));
		const authSessions = auth.repository;
		const maintenance: BackgroundMaintenance = {
			async recoverStaleUploads(signal) {
				await gameUpload.recoverStaleUploads(signal);
				if (!signal?.aborted) await uploadTempScavenger.sweep(signal);
			},
			async purgeExpiredSessions(before, signal) {
				if (signal?.aborted) return 0;
				return persistence.authRepository.purgeExpired(before);
			},
			reapOrphans: (signal) => uploadLifecycle.recover(signal),
		};
		const maintenanceSchedule = createMaintenanceSchedule(scheduler, clock, maintenance, logger);
		owner.register('maintenanceSchedule', owned(
			maintenanceSchedule,
			() => maintenanceSchedule.close(),
			() => maintenanceSchedule.start(),
		));
		const routes = options.routes ?? await factories.routes(
			config,
			assetsBanned!,
			auth,
			publicGraph,
			projectMemberSettings,
			year,
			importExport,
			projectMultipart,
			gameUpload,
		);

		return {
			config,
			clock,
			logger,
			ids,
			storage,
			fileSystem,
			googleTokens,
			scheduler,
			uploadLimiter,
			protectedDownloads,
			settings,
			exportProgress,
			uploadLifecycleMetrics,
			uploadLifecycle,
			lifecycle,
			databaseHealth,
			authSessions,
			maintenance,
			routes,
			resourceOwnership: owner.ownership(),
			start: () => owner.start(),
			close: () => owner.close(),
		};
	} catch (error) {
		await owner.close().catch(() => undefined);
		throw error;
	}
}
