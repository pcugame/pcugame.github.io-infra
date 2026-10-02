import type { S3Client } from '@aws-sdk/client-s3';
import type { FastifyPluginAsync } from 'fastify';
import type {
	Clock,
	IdGenerator,
} from '../application/ports.js';
import type { Env } from '../config/env.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
	createDirectMultipartControlStorage,
	createMultipartPartPresigner,
	type ProtectedDownloadPresigner,
} from '../lib/storage.js';
import type { ImportExportProductionGraph } from '../modules/admin/import-export.composition.js';
import type { createProjectAccessService } from '../modules/admin/project-access.service.js';
import type { ProjectMemberSettingsProductionGraph } from '../modules/admin/project-member-settings.composition.js';
import {
	createProjectMultipartProductionGraph,
	type ProjectMultipartProductionGraph,
} from '../modules/admin/project-multipart.composition.js';
import type { YearProductionGraph } from '../modules/admin/year/composition.js';
import { createAssetUploadControlGraph, createUnavailableAssetUploadControlGraph } from '../modules/asset-upload/composition.js';
import type { createAssetUploadRepository } from '../modules/asset-upload/repository.js';
import type { AssetsBannedProductionGraph } from '../modules/assets/composition.js';
import type { AuthProductionGraph } from '../modules/auth/composition.js';
import { createExternalLinkController } from '../modules/external-links/controller.js';
import { createFileAccessController } from '../modules/file-access/controller.js';
import { createFileAccessRepository, createUnavailableFileAccessRepository } from '../modules/file-access/repository.js';
import { createWebglDisplayController } from '../modules/me/project/webgl-display.controller.js';
import { createWebglDisplayRepository } from '../modules/me/project/webgl-display.repository.js';
import { createWebglDisplayService } from '../modules/me/project/webgl-display.service.js';
import { createUnavailableProjectChangeService } from '../modules/project-change/composition.js';
import { createProjectChangeController } from '../modules/project-change/controller.js';
import { createProjectChangeService } from '../modules/project-change/service.js';
import type { PublicProductionGraph } from '../modules/public/composition.js';
import type { UploadLifecycleRuntime } from '../modules/upload-lifecycle/runtime.js';
import { createWebglNetworkController } from '../modules/webgl-network/controller.js';
import { createUnavailableWebglNetworkRepository, createWebglNetworkRepository } from '../modules/webgl-network/repository.js';
import { createWebglNetworkService } from '../modules/webgl-network/service.js';
import { createWebglPlayController } from '../modules/webgl-play/controller.js';
import { createUnavailableWebglPlayRepository, createWebglPlayRepository } from '../modules/webgl-play/repository.js';
import { createWebglPlayService } from '../modules/webgl-play/service.js';
import { forbidden, notFound } from '../shared/errors.js';
import { resolveRoleUploadLimits } from '../shared/upload-policy.js';
import type { BackendPersistencePorts } from './persistence.js';

export interface BackendRoutes {
	fileAccess?: FastifyPluginAsync;
	webglPlay?: FastifyPluginAsync;
	auth: FastifyPluginAsync;
	devAuth: FastifyPluginAsync;
	public: FastifyPluginAsync;
	admin: FastifyPluginAsync;
	me: FastifyPluginAsync;
	assets: FastifyPluginAsync;
}

export async function loadProductionRoutes(
	_config: Env,
	assetsBanned: AssetsBannedProductionGraph,
	auth: AuthProductionGraph,
	publicGraph: PublicProductionGraph,
	projectMemberSettings: ProjectMemberSettingsProductionGraph,
	year: YearProductionGraph,
	importExport: ImportExportProductionGraph,
	projectMultipart: ProjectMultipartProductionGraph,
	directAssetUpload: ReturnType<typeof createAssetUploadControlGraph> | ReturnType<typeof createUnavailableAssetUploadControlGraph>,
): Promise<BackendRoutes> {
	const admin = await import('../modules/admin/admin.routes.js');
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
			directAssetUploadController: directAssetUpload.controller,
		}),
		me: projectMultipart.meController,
		assets: assetsBanned.assetsController,
	};
}

export function createBackendProjectMultipart({ prisma, config, uploadLifecycle, projectMemberSettings }: {
	prisma: PrismaClient | undefined;
	config: Env;
	uploadLifecycle: UploadLifecycleRuntime;
	projectMemberSettings: ProjectMemberSettingsProductionGraph;
}) {
	return createProjectMultipartProductionGraph({
		webglDisplayController: prisma ? createWebglDisplayController(createWebglDisplayService(createWebglDisplayRepository(prisma))) : createWebglDisplayController(createWebglDisplayService({
			read: async () => { throw new Error('WebGL display persistence is unavailable'); },
			write: async () => { throw new Error('WebGL display persistence is unavailable'); },
		})),
		config,
		uploadLifecycle,
		access: projectMemberSettings.projectAccess,
		repository: projectMemberSettings.projectRepository,
	});
}

export function createBackendDirectAssetUpload({
	prisma,
	directAssetUploadRepository,
	s3,
	directSigningS3,
	clock,
	ids,
	config,
	projectAccess,
	uploadLifecycle,
}: {
	prisma: PrismaClient | undefined;
	directAssetUploadRepository: ReturnType<typeof createAssetUploadRepository> | undefined;
	s3: S3Client;
	directSigningS3: S3Client;
	clock: Clock;
	ids: IdGenerator;
	config: Env;
	projectAccess: ReturnType<typeof createProjectAccessService>;
	uploadLifecycle: UploadLifecycleRuntime;
}) {
	return prisma && directAssetUploadRepository ? createAssetUploadControlGraph({
		repository: directAssetUploadRepository,
		storage: createDirectMultipartControlStorage(s3),
		partSigner: createMultipartPartPresigner(directSigningS3),
		clock,
		ids,
		config: {
			bucket: config.S3_BUCKET_PROTECTED,
			sessionTtlMs: config.UPLOAD_SESSION_TTL_MINUTES * 60_000,
			partSizeBytes: config.DIRECT_UPLOAD_PART_SIZE_MB * 1024 * 1024,
			partUrlTtlSeconds: config.DIRECT_UPLOAD_PART_URL_TTL_SEC,
			partUrlRefreshMax: config.DIRECT_UPLOAD_PART_URL_REFRESH_MAX,
			maxBytesFor: (actor, kind) => {
				const limits = resolveRoleUploadLimits(config, actor.role);
				if (kind === 'DOCUMENT' || kind === 'ATTACHMENT') return 50 * 1024 * 1024;
				if (kind === 'VIDEO') return limits.videoMaxBytes;
				if (kind === 'IMAGE') return limits.imageMaxBytes;
				if (kind === 'POSTER') return limits.posterMaxBytes;
				return limits.gameMaxBytes;
			},
		},
		authorizeProjectWrite: async (actor, projectId) => projectAccess.loadProjectForUpload(actor as Parameters<typeof projectAccess.loadProjectForUpload>[0], projectId),
		authorizeExhibitionWrite: async (actor, exhibitionId) => {
			if (actor.role !== 'ADMIN' && actor.role !== 'OPERATOR') {
				throw forbidden('Only operators can modify exhibition assets');
			}
			const exhibition = await prisma.exhibition.findUnique({ where: { id: exhibitionId }, select: { id: true } });
			if (!exhibition) throw notFound('Exhibition not found');
		},
		wakeMaintenance: () => uploadLifecycle.wakeMaintenance(),
	}) : createUnavailableAssetUploadControlGraph();
}

export function composeBackendRoutes({
	baseRoutes,
	hasSuppliedRoutes,
	hasSuppliedPersistence,
	persistence,
	prisma,
	config,
	clock,
	protectedDownloadPresigner,
	assetsBanned,
}: {
	baseRoutes: BackendRoutes;
	hasSuppliedRoutes: boolean;
	hasSuppliedPersistence: boolean;
	persistence: BackendPersistencePorts;
	prisma: PrismaClient | undefined;
	config: Env;
	clock: Clock;
	protectedDownloadPresigner: ProtectedDownloadPresigner;
	assetsBanned: AssetsBannedProductionGraph | undefined;
}): BackendRoutes {
	const routes = { ...baseRoutes };
	if (!hasSuppliedRoutes) {
		const webglPlay = createWebglPlayService(
			persistence.webglPlayRepository ?? (prisma && !hasSuppliedPersistence
				? createWebglPlayRepository(prisma) : createUnavailableWebglPlayRepository()),
			config,
			() => clock.now(),
		);
		routes.webglPlay = createWebglPlayController(webglPlay, config, () => clock.now());
		const fileAccess = createFileAccessController(
			persistence.fileAccessRepository ?? (prisma && !hasSuppliedPersistence
				? createFileAccessRepository(prisma) : createUnavailableFileAccessRepository()),
			config,
			() => clock.now(),
			(bucket, key, options) => protectedDownloadPresigner.presign(bucket, key, { ttlSec: 60, ...options }),
			assetsBanned!.authorizeDownload,
			webglPlay.resolveRuntime,
		);
		routes.fileAccess = fileAccess;
		routes.assets = async app => {
			app.addHook('onSend', async (request, reply, payload) => {
				const location = reply.getHeader('location');
				if (reply.statusCode === 302 && typeof location === 'string') {
					const grant = await fileAccess.issue(new URL(request.url, config.API_PUBLIC_URL).toString(), { ...request, downloadAlreadyChecked: true });
					reply.header('location', grant.url).header('Cache-Control', 'private, no-store');
				}
				return payload;
			});
			await app.register(baseRoutes.assets);
		};
	}
	if (!hasSuppliedRoutes) {
		const changes = persistence.projectChangeRepository
			? createProjectChangeService(persistence.projectChangeRepository)
			: createUnavailableProjectChangeService();
		const network = createWebglNetworkService(
			persistence.webglNetworkRepository ?? (prisma && !hasSuppliedPersistence
				? createWebglNetworkRepository(prisma) : createUnavailableWebglNetworkRepository()),
			config,
			() => clock.now(),
		);
		routes.me = async (app) => {
			await app.register(baseRoutes.me);
			await app.register(createExternalLinkController());
			await app.register(createProjectChangeController(changes, 'me'));
			await app.register(createWebglNetworkController(network, 'me'));
		};
		routes.admin = async (app) => {
			await app.register(baseRoutes.admin);
			await app.register(createProjectChangeController(changes, 'admin'));
			await app.register(createWebglNetworkController(network, 'admin'));
		};
	}

	return routes;
}
