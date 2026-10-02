import type { DatabaseHealth } from '../application/ports.js';
import type { Env } from '../config/env.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaHealth } from '../infrastructure/production-ports.js';
import { createBannedIpRepository } from '../modules/admin/banned-ip/repository.js';
import type { BannedIpServiceDependencies } from '../modules/admin/banned-ip/service.js';
import { createExportRepository } from '../modules/admin/export/repository.js';
import type { ExportRepository } from '../modules/admin/import-export.composition.js';
import { createImportRepository } from '../modules/admin/import/repository.js';
import type { ImportRepository } from '../modules/admin/import/service.js';
import { createMemberRepository } from '../modules/admin/member/repository.js';
import type { MemberServiceDependencies } from '../modules/admin/member/service.js';
import { createProjectAccessRepository } from '../modules/admin/project-access.repository.js';
import type { ProjectAccessRepository } from '../modules/admin/project-access.service.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import type { ProjectApplicationRepository } from '../modules/admin/project/ports.js';
import type { ExhibitionRepository } from '../modules/admin/year/ports.js';
import { createExhibitionRepository } from '../modules/admin/year/repository.js';
import { createAssetsRepository } from '../modules/assets/repository.js';
import type { AssetsServiceDependencies } from '../modules/assets/service.js';
import type { AuthProductionRepository } from '../modules/auth/composition.js';
import { createAuthRepository } from '../modules/auth/repository.js';
import type { FileAccessRepository } from '../modules/file-access/repository.js';
import type { ProjectChangeRepository } from '../modules/project-change/ports.js';
import { createProjectChangeRepository } from '../modules/project-change/repository.js';
import type { PublicProductionRepository } from '../modules/public/composition.js';
import { createPublicRepository } from '../modules/public/repository.js';
import type { WebglNetworkRepository } from '../modules/webgl-network/repository.js';
import type { WebglPlayRepository } from '../modules/webgl-play/repository.js';

/**
 * Complete persistence boundary consumed by the production composition graph.
 * Production builds it from one Prisma client; composition/lifecycle tests inject
 * scripted domain ports and never need to construct or emulate Prisma delegates.
 */
export interface BackendPersistencePorts {
	fileAccessRepository?: FileAccessRepository;
	webglPlayRepository?: WebglPlayRepository;
	webglNetworkRepository?: WebglNetworkRepository;
	databaseHealth: DatabaseHealth;
	authRepository: AuthProductionRepository;
	publicRepository: PublicProductionRepository;
	projectAccessRepository: ProjectAccessRepository;
	projectChangeRepository?: ProjectChangeRepository;
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

export function createBackendPersistence(prisma: PrismaClient | undefined, config: Env): BackendPersistencePorts {
	if (!prisma) throw new Error('Prisma persistence was not initialized');
	return {
		databaseHealth: createPrismaHealth(prisma),
		authRepository: createAuthRepository(prisma),
		publicRepository: createPublicRepository(prisma),
		projectAccessRepository: createProjectAccessRepository(prisma),
		projectChangeRepository: createProjectChangeRepository(prisma),
		projectRepository: createProjectCrudRepository(prisma, {
			publicBucket: config.S3_BUCKET_PUBLIC,
			protectedBucket: config.S3_BUCKET_PROTECTED,
		}),
		memberRepository: createMemberRepository(prisma),
		exhibitionRepository: createExhibitionRepository(prisma),
		assetsRepository: createAssetsRepository(prisma),
		bannedIpRepository: createBannedIpRepository(prisma),
		importRepository: createImportRepository(prisma),
		exportRepository: createExportRepository(prisma),
	};
}
