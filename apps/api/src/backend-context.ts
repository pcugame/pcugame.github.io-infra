import type {
	AppLogger,
	AuthSessionStore,
	BackgroundMaintenance,
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
} from './application/ports.js';
import type { Env } from './config/env.js';
import {
	createUploadLifecycleMetrics,
	type UploadLifecycleMetrics,
} from './lib/upload-lifecycle-metrics.js';
import { createImportExportProductionGraph } from './modules/admin/import-export.composition.js';
import { createProjectAccessService } from './modules/admin/project-access.service.js';
import { createProjectMemberSettingsProductionGraph } from './modules/admin/project-member-settings.composition.js';
import { createYearProductionGraph } from './modules/admin/year/composition.js';
import { createAssetUploadRepository } from './modules/asset-upload/repository.js';
import {
	createAssetsBannedProductionGraph,
	type AssetsBannedProductionGraph,
} from './modules/assets/composition.js';
import { createAuthProductionGraph } from './modules/auth/composition.js';
import { createPublicProductionGraph } from './modules/public/composition.js';
import {
	createProductionUploadLifecycleRuntime,
	type UploadLifecycleRuntime,
} from './modules/upload-lifecycle/runtime.js';
import type { DownloadRateLimiter } from './shared/download-rate-limit.js';
import {
	defaultFactories,
	type MaybePromise,
	type ProductionResourceFactories,
	type ProductionResourceOverrides,
} from './backend-context/infrastructure.js';
import { createBackendMaintenance, createMaintenanceSchedule } from './backend-context/maintenance.js';
import { createBackendPersistence, type BackendPersistencePorts } from './backend-context/persistence.js';
import {
	BackendResourceOwner,
	owned,
	type BackendResourceOwnership,
	type ResourceLease,
} from './backend-context/resource-owner.js';
import {
	composeBackendRoutes,
	createBackendDirectAssetUpload,
	createBackendProjectMultipart,
	type BackendRoutes,
} from './backend-context/routes.js';

export type { ProductionResourceFactories, ProductionResourceOverrides } from './backend-context/infrastructure.js';
export { createMaintenanceSchedule, createSingleFlightUploadRecovery } from './backend-context/maintenance.js';
export type { BackendPersistencePorts } from './backend-context/persistence.js';
export type { BackendResourceOwnership, ResourceLease, ResourceOwnership } from './backend-context/resource-owner.js';
export type { BackendRoutes } from './backend-context/routes.js';

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

export interface CreateProductionBackendContextOptions {
	/** Construction hooks are test seams; their output is owned by the context. */
	factories?: Partial<ProductionResourceFactories>;
	/** Supplied live resources must state whether the context owns them. */
	resources?: Partial<ProductionResourceOverrides>;
	/** Complete non-Prisma persistence seam for composition and lifecycle tests. */
	persistence?: BackendPersistencePorts;
	routes?: BackendRoutes;
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
		// Presigning must use the browser-visible NAS upload origin. It is a
		// separate S3 client so internal Garage endpoints never leak into URLs.
		const directSigningS3 = await resource(
			'uploadSigningS3',
			() => factories.uploadSigningS3(config),
			(client) => client.destroy(),
		);
		const protectedDownloadSigningS3 = await resource(
			'protectedDownloadSigningS3',
			() => factories.protectedDownloadSigningS3(config),
			(client) => client.destroy(),
		);
		const protectedDownloadPresigner = await factories.protectedDownloadPresigner(
			protectedDownloadSigningS3,
			config,
		);
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
		const persistence = options.persistence ?? createBackendPersistence(prisma, config);
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
			logger,
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
			uploadLifecycle,
		});
		let assetsBanned: AssetsBannedProductionGraph | undefined;
		if (!options.routes) {
			const graph = createAssetsBannedProductionGraph({
				config,
				assetsRepository: persistence.assetsRepository,
				bannedIpRepository: persistence.bannedIpRepository,
				projectAccess,
				protectedDownloadPresigner,
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
			importRepository: persistence.importRepository,
			exportRepository: persistence.exportRepository,
			ids,
		});
		owner.register('importExport', owned(
			importExport,
			() => importExport.close(),
		));
		const projectMultipart = createBackendProjectMultipart({ prisma, config, uploadLifecycle, projectMemberSettings });
		const directAssetUploadRepository = prisma ? createAssetUploadRepository(prisma) : undefined;
		const directAssetUpload = createBackendDirectAssetUpload({
			prisma,
			directAssetUploadRepository,
			s3,
			directSigningS3,
			clock,
			ids,
			config,
			projectAccess,
			uploadLifecycle,
		});
		const maintenance = createBackendMaintenance({
			config,
			directAssetUploadRepository,
			s3,
			clock,
			ids,
			logger,
			uploadLifecycle,
			persistence,
		});
		const authSessions = auth.repository;
		const maintenanceSchedule = createMaintenanceSchedule(scheduler, clock, maintenance, logger);
		owner.register('maintenanceSchedule', owned(
			maintenanceSchedule,
			() => maintenanceSchedule.close(),
			() => maintenanceSchedule.start(),
		));
		const baseRoutes = options.routes ?? await factories.routes(
			config,
			assetsBanned!,
			auth,
			publicGraph,
			projectMemberSettings,
			year,
			importExport,
			projectMultipart,
			directAssetUpload,
		);

		const routes = composeBackendRoutes({
			baseRoutes,
			hasSuppliedRoutes: Boolean(options.routes),
			hasSuppliedPersistence: Boolean(options.persistence),
			persistence,
			prisma,
			config,
			clock,
			protectedDownloadPresigner,
			assetsBanned,
		});

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
