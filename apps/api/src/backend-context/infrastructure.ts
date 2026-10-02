import type { S3Client } from '@aws-sdk/client-s3';
import type {
	AppLogger,
	Clock,
	FileSystem,
	GoogleTokenVerifier,
	IdGenerator,
	Lifecycle,
	ObjectStorage,
	Scheduler,
	SettingsStore,
	UploadLimiter,
} from '../application/ports.js';
import type { Env } from '../config/env.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
	createCryptoIdGenerator,
	createGoogleTokenVerifier,
	createLifecyclePort,
	createNodeFileSystem,
	createNodeScheduler,
	createPrismaSettingsStore,
	createSystemClock,
	createUploadLimiterPort,
} from '../infrastructure/production-ports.js';
import { createRootLogger } from '../lib/logger.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createS3Client } from '../lib/s3.js';
import {
	createObjectStorage,
	createProtectedDownloadPresigner,
	type ProtectedDownloadPresigner,
} from '../lib/storage.js';
import type { ImportExportProductionGraph } from '../modules/admin/import-export.composition.js';
import type { ProjectMemberSettingsProductionGraph } from '../modules/admin/project-member-settings.composition.js';
import type { ProjectMultipartProductionGraph } from '../modules/admin/project-multipart.composition.js';
import type { YearProductionGraph } from '../modules/admin/year/composition.js';
import type { createAssetUploadControlGraph, createUnavailableAssetUploadControlGraph } from '../modules/asset-upload/composition.js';
import type { AssetsBannedProductionGraph } from '../modules/assets/composition.js';
import type { AuthProductionGraph } from '../modules/auth/composition.js';
import type { PublicProductionGraph } from '../modules/public/composition.js';
import type { UploadLifecycleRuntime } from '../modules/upload-lifecycle/runtime.js';
import type { DownloadRateLimiter } from '../shared/download-rate-limit.js';
import { createProtectedDownloadLimiter } from '../shared/protected-download-limiter.js';
import type { ResourceLease } from './resource-owner.js';
import { loadProductionRoutes, type BackendRoutes } from './routes.js';

export type MaybePromise<T> = T | Promise<T>;

export interface ProductionResourceFactories {
	logger(config: Env): MaybePromise<AppLogger>;
	clock(config: Env): MaybePromise<Clock>;
	ids(config: Env): MaybePromise<IdGenerator>;
	scheduler(config: Env): MaybePromise<Scheduler>;
	fileSystem(config: Env): MaybePromise<FileSystem>;
	googleTokens(config: Env): MaybePromise<GoogleTokenVerifier>;
	prisma(config: Env): MaybePromise<PrismaClient>;
	s3(config: Env): MaybePromise<S3Client>;
	uploadSigningS3(config: Env): MaybePromise<S3Client>;
	protectedDownloadSigningS3(config: Env): MaybePromise<S3Client>;
	storage(client: S3Client, config: Env): MaybePromise<ObjectStorage>;
	protectedDownloadPresigner(client: S3Client, config: Env): MaybePromise<ProtectedDownloadPresigner>;
	settings(
		client: PrismaClient,
		logger: AppLogger,
		config: Env,
	): MaybePromise<SettingsStore & { warmup?(): Promise<unknown>; close(): void }>;
	uploadLimiter(config: Env): MaybePromise<UploadLimiter & { close(): void }>;
	lifecycle(clock: Clock, scheduler: Scheduler, config: Env): MaybePromise<Lifecycle & { close(): void }>;
	protectedDownloads(clock: Clock, scheduler: Scheduler, config: Env): MaybePromise<DownloadRateLimiter>;
	routes(
		config: Env,
		assetsBanned: AssetsBannedProductionGraph,
		auth: AuthProductionGraph,
		publicGraph: PublicProductionGraph,
		projectMemberSettings: ProjectMemberSettingsProductionGraph,
		year: YearProductionGraph,
		importExport: ImportExportProductionGraph,
		projectMultipart: ProjectMultipartProductionGraph,
		directAssetUpload: ReturnType<typeof createAssetUploadControlGraph> | ReturnType<typeof createUnavailableAssetUploadControlGraph>,
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
	uploadSigningS3: ResourceLease<S3Client>;
	protectedDownloadSigningS3: ResourceLease<S3Client>;
	storage: ResourceLease<ObjectStorage>;
	settings: ResourceLease<SettingsStore>;
	uploadLimiter: ResourceLease<UploadLimiter>;
	lifecycle: ResourceLease<Lifecycle>;
	protectedDownloads: ResourceLease<DownloadRateLimiter>;
	uploadLifecycle: ResourceLease<UploadLifecycleRuntime>;
}

export const defaultFactories: ProductionResourceFactories = {
	logger: (config) => createRootLogger(config),
	clock: () => createSystemClock(),
	ids: () => createCryptoIdGenerator(),
	scheduler: () => createNodeScheduler(),
	fileSystem: () => createNodeFileSystem(),
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
	uploadSigningS3: (config) => createS3Client({
		...config,
		S3_ENDPOINT: config.S3_PUBLIC_SIGNING_ENDPOINT ?? config.S3_ENDPOINT,
	}),
	protectedDownloadSigningS3: (config) => createS3Client({
		...config,
		S3_ENDPOINT: config.S3_PROTECTED_DOWNLOAD_SIGNING_ENDPOINT ?? config.S3_ENDPOINT,
	}),
	storage: (client, config) => createObjectStorage(client, {
		defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC,
	}),
	protectedDownloadPresigner: (client, config) => createProtectedDownloadPresigner(client, {
		defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC,
	}),
	settings: (client, logger) => createPrismaSettingsStore(client, logger),
	uploadLimiter: (config) => createUploadLimiterPort(config.UPLOAD_MAX_CONCURRENT),
	lifecycle: (clock, scheduler) => createLifecyclePort(clock, scheduler),
	protectedDownloads: (clock, scheduler, config) => createProtectedDownloadLimiter({ clock, scheduler, autoIpBanEnabled: config.DOWNLOAD_AUTO_IP_BAN_ENABLED }),
	routes: loadProductionRoutes,
};

