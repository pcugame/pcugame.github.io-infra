import type { BackendPersistencePorts } from '../../backend-context.js';

function unscripted(operation: string): never {
	throw new Error(`Unscripted persistence operation: ${operation}`);
}

/**
 * Complete application-port fixture for composition/lifecycle tests.
 * It deliberately models no SQL, transaction, delegate, or rollback behavior.
 */
export function createScriptedBackendPersistence(
	overrides: Partial<BackendPersistencePorts> = {},
): BackendPersistencePorts {
	const defaults: BackendPersistencePorts = {
		databaseHealth: { check: async () => true },
		authRepository: {
			find: async () => null,
			touch: async () => undefined,
			delete: async () => undefined,
			purgeExpired: async () => 0,
			upsertUserByGoogleSub: async () => unscripted('auth.upsertUserByGoogleSub'),
			upsertDevUser: async () => unscripted('auth.upsertDevUser'),
			createSession: async () => unscripted('auth.createSession'),
		},
		publicRepository: {
			findExhibitionsWithPublishedCounts: async () => [],
			findExhibitionsByYear: async () => [],
			findPublishedProjectsInExhibitions: async () => [],
			findExhibitionById: async () => null,
			findExhibitionPosterByStorageKey: async () => null,
			findPublishedProjectById: async () => null,
			findPublishedProjectBySlug: async () => null,
			findPublicWebglProject: async () => null,
		},
		projectAccessRepository: {
			findProject: async () => null,
			isLinkedMember: async () => false,
		},
		projectRepository: {
			findProjectsForUser: async () => ({ items: [], totalItems: 0 }),
			findProjectById: async () => null,
			isMemberOfProject: async () => null,
			updateProject: async () => unscripted('project.updateProject'),
			deleteProjectReturningAssets: async () => unscripted('project.deleteProjectReturningAssets'),
			clearWebglDeployment: async () => unscripted('project.clearWebglDeployment'),
			findAssetById: async () => null,
			setProjectPoster: async () => unscripted('project.setProjectPoster'),
			bulkDeleteProjectsReturningAssets: async () => unscripted('project.bulkDeleteProjectsReturningAssets'),
			findExhibitionById: async () => null,
			findProjectByExhibitionAndSlug: async () => null,
			createProjectWithAssets: async () => unscripted('project.createProjectWithAssets'),
			createAsset: async () => unscripted('project.createAsset'),
			replaceOrCreateReplaceableAsset: async () => unscripted('project.replaceOrCreateReplaceableAsset'),
			bulkUpdateStatus: async () => ({ count: 0 }),
		},
		memberRepository: {
			createMember: async () => unscripted('member.createMember'),
			findMemberInProject: async () => null,
			updateMember: async () => unscripted('member.updateMember'),
			deleteMember: async () => unscripted('member.deleteMember'),
			swapMemberOrder: async () => null,
		},
		exhibitionRepository: {
			findAllExhibitions: async () => [],
			findExhibitionByComposite: async () => null,
			findExhibitionById: async () => null,
			findExhibitionByIdWithCount: async () => null,
			createExhibition: async () => unscripted('exhibition.createExhibition'),
			deleteExhibition: async () => null,
			updateExhibition: async () => unscripted('exhibition.updateExhibition'),
			replaceExhibitionPoster: async () => null,
			clearExhibitionPoster: async () => null,
		},
		assetsRepository: {
			findPublicAsset: async () => null,
			findAssetByStorageKey: async () => null,
			upsertBannedIp: async () => undefined,
			findAssetByIdWithProject: async () => null,
			claimAssetForDeletion: async () => null,
			completeAssetDeletion: async () => undefined,
			findAllBannedIps: async () => [],
		},
		bannedIpRepository: {
			findAllBannedIps: async () => [],
			findBannedIpById: async () => null,
			deleteBannedIp: async () => undefined,
		},
		importRepository: {
			findExhibitionForPreview: async () => null,
			runTransaction: async () => unscripted('import.runTransaction'),
		},
		exportRepository: {
			findProjectsWithAssets: async () => [],
		},
	};

	return { ...defaults, ...overrides };
}
