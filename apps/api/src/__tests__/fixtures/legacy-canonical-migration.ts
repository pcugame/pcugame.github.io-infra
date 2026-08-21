/**
 * A deliberately small, production-shaped snapshot of the schema at
 * origin/master (6288dd2).  It is a fixture for expand/backfill/contract
 * migration tests, not seed data for a running application.
 *
 * Every key is intentionally a legacy key.  Consumers must use the manifest
 * below to assert the canonical AssetRepresentation/WebglDeployment result
 * instead of treating these keys as the target public API.
 */

export const LEGACY_MIGRATION_FIXTURE_NAMESPACE = 'migration-fixture-20260821';

export type LegacyHeadObject = {
	bucket: 'protected' | 'public';
	key: string;
	mimeType: string;
	size: bigint;
	etag: string;
	checksumSha256: string;
};

type LegacyAsset = {
	id: number;
	projectId: number;
	kind: 'GAME' | 'VIDEO' | 'POSTER' | 'IMAGE';
	status: 'READY' | 'DELETED' | 'FAILED';
	storageKey: string;
	playbackStorageKey: string | null;
	originalName: string;
	mimeType: string;
	playbackMimeType: string;
	sizeBytes: bigint;
	playbackSizeBytes: bigint;
	playbackStatus: 'PENDING' | 'READY' | 'FAILED';
	isPublic: boolean;
	width: number | null;
	height: number | null;
	card480Height: number | null;
	display960Height: number | null;
};

/** Shape of master GameUploadSession for a successfully completed WEBGL upload. */
type LegacyWebglUploadSession = {
	id: string;
	projectId: number;
	userId: number;
	uploadKind: 'WEBGL';
	originalName: string;
	totalBytes: bigint;
	chunkSizeBytes: number;
	totalChunks: number;
	uploadedChunks: number[];
	status: 'COMPLETED';
	stagingPath: string;
	storageKey: string;
	s3UploadId: string;
	s3Key: string;
	s3PartEtags: Array<{ partNumber: number; etag: string }>;
	multipartGeneration: number;
	completionClaimToken: string | null;
	completionClaimUntil: null;
	completionLastError: string | null;
	completionResult: { status: 'COMPLETED'; storageKey: string; sizeBytes: number; webglUrl: string };
	expiresAt: Date;
};

const publishedProjectId = 41_021;
const archivedProjectId = 41_022;
const exhibitionId = 41_001;
const creatorId = 41_011;
const unresolvedProjectId = 41_023;

const posterKey = 'project-assets/2025/old poster + 서울.png';
const imageKey = 'images/2024/졸업작품/planet@2x.webp';
const exhibitionPosterKey = 'years/2025/poster final.jpg';
const webglDeploymentId = '3f3df944-a7e3-430d-a9c1-915caa2e1d5b';
const webglPublicPrefix = `webgl/${archivedProjectId}/${webglDeploymentId}/site/`;
const webglSourceKey = `webgl/${archivedProjectId}/${webglDeploymentId}/source.zip`;

export const legacyCanonicalMigrationFixture = {
	users: [{
		id: creatorId,
		googleSub: `${LEGACY_MIGRATION_FIXTURE_NAMESPACE}:creator`,
		email: 'migration-fixture@example.test',
		studentId: 'MIGRATION-41011',
		name: 'Migration Fixture Creator',
		role: 'ADMIN' as const,
	}],
	exhibitions: [{
		id: exhibitionId,
		year: 2525,
		title: 'Legacy canonical migration fixture',
		isUploadEnabled: true,
		sortOrder: 1,
		posterStorageKey: exhibitionPosterKey,
		posterOriginalName: '2025 exhibition poster.jpg',
		posterMimeType: 'image/jpeg',
		posterSizeBytes: 310_001n,
		posterWidth: 1_600,
		posterHeight: 900,
		posterCard480Height: 270,
		posterDisplay960Height: 540,
	}],
	projects: [{
		id: publishedProjectId,
		exhibitionId,
		slug: 'legacy-published-project',
		title: 'Legacy published project',
		status: 'PUBLISHED' as const,
		creatorId,
		posterAssetId: 42_003,
		webglEntryKey: '',
	}, {
		id: archivedProjectId,
		exhibitionId,
		slug: 'legacy-archived-webgl',
		title: 'Legacy archived WebGL project',
		status: 'ARCHIVED' as const,
		creatorId,
		posterAssetId: null,
		webglEntryKey: `${webglPublicPrefix}index.html`,
	}, {
		// This is deliberately a separate legacy row: it advertises a malformed
		// deployment path and has no completed WEBGL session/source locator. A
		// migration must report it unresolved rather than inventing a deployment.
		id: unresolvedProjectId,
		exhibitionId,
		slug: 'legacy-unresolved-webgl',
		title: 'Legacy unresolved WebGL project',
		status: 'ARCHIVED' as const,
		creatorId,
		posterAssetId: null,
		webglEntryKey: `webgl/${unresolvedProjectId}/not-a-generation/index.html`,
	}],
	assets: [{
		id: 42_001,
		projectId: publishedProjectId,
		kind: 'GAME', status: 'READY',
		storageKey: 'uploads/games/2025/legacy-game_한글.zip',
		playbackStorageKey: null,
		originalName: 'legacy-game_한글.zip', mimeType: 'application/zip', playbackMimeType: '',
		sizeBytes: 4_194_304n, playbackSizeBytes: 0n, playbackStatus: 'PENDING', isPublic: false,
		width: null, height: null, card480Height: null, display960Height: null,
	}, {
		id: 42_002,
		projectId: publishedProjectId,
		kind: 'VIDEO', status: 'READY',
		storageKey: 'uploads/videos/2025/recording source.mov',
		playbackStorageKey: 'video/processed/42_002/playback-h264.mp4',
		originalName: 'recording source.mov', mimeType: 'video/quicktime', playbackMimeType: 'video/mp4',
		sizeBytes: 8_388_608n, playbackSizeBytes: 2_097_152n, playbackStatus: 'READY', isPublic: false,
		width: 1_920, height: 1_080, card480Height: null, display960Height: null,
	}, {
		id: 42_003,
		projectId: publishedProjectId,
		kind: 'POSTER', status: 'READY', storageKey: posterKey, playbackStorageKey: null,
		originalName: 'old poster + 서울.png', mimeType: 'image/png', playbackMimeType: '',
		sizeBytes: 512_000n, playbackSizeBytes: 0n, playbackStatus: 'PENDING', isPublic: true,
		width: 1_440, height: 900, card480Height: 300, display960Height: 600,
	}, {
		id: 42_004,
		projectId: publishedProjectId,
		kind: 'IMAGE', status: 'READY', storageKey: imageKey, playbackStorageKey: null,
		originalName: 'planet@2x.webp', mimeType: 'image/webp', playbackMimeType: '',
		sizeBytes: 200_100n, playbackSizeBytes: 0n, playbackStatus: 'PENDING', isPublic: true,
		width: 1_200, height: 800, card480Height: 320, display960Height: 640,
	}, {
		// A WEBGL source archive was represented as GAME before UploadKind WEBGL
		// existed as a first-class domain asset.
		id: 42_005,
		projectId: archivedProjectId,
		kind: 'GAME', status: 'READY',
		storageKey: webglSourceKey, playbackStorageKey: null,
		originalName: 'archived-webgl-build.zip', mimeType: 'application/zip', playbackMimeType: '',
		sizeBytes: 6_291_456n, playbackSizeBytes: 0n, playbackStatus: 'PENDING', isPublic: false,
		width: null, height: null, card480Height: null, display960Height: null,
	}, {
		id: 42_006,
		projectId: archivedProjectId,
		kind: 'IMAGE', status: 'DELETED',
		storageKey: 'deleted/legacy-image-42_006.png', playbackStorageKey: null,
		originalName: 'deleted-image.png', mimeType: 'image/png', playbackMimeType: '',
		sizeBytes: 100n, playbackSizeBytes: 0n, playbackStatus: 'PENDING', isPublic: false,
		width: null, height: null, card480Height: null, display960Height: null,
	}, {
		id: 42_007,
		projectId: archivedProjectId,
		kind: 'VIDEO', status: 'FAILED',
		storageKey: 'failed/legacy-video-42_007.webm', playbackStorageKey: null,
		originalName: 'failed-video.webm', mimeType: 'video/webm', playbackMimeType: '',
		sizeBytes: 100n, playbackSizeBytes: 0n, playbackStatus: 'FAILED', isPublic: false,
		width: null, height: null, card480Height: null, display960Height: null,
	}] satisfies readonly LegacyAsset[],
	gameUploadSessions: [{
		// The completed session is the legacy DB-shaped proof that asset 42_005
		// is the immutable WebGL deployment's source archive.
		id: 'a1017537-6772-4ccd-8e49-4ccf8609a2a1',
		projectId: archivedProjectId,
		userId: creatorId,
		uploadKind: 'WEBGL',
		originalName: 'archived-webgl-build.zip',
		totalBytes: 6_291_456n,
		chunkSizeBytes: 6_291_456,
		totalChunks: 1,
		uploadedChunks: [0],
		status: 'COMPLETED',
		stagingPath: '',
		storageKey: webglSourceKey,
		s3UploadId: 'legacy-webgl-upload-id-42005',
		s3Key: webglSourceKey,
		s3PartEtags: [{ partNumber: 1, etag: '"legacy-webgl-source-etag"' }],
		multipartGeneration: 1,
		completionClaimToken: null,
		completionClaimUntil: null,
		completionLastError: null,
		completionResult: {
			status: 'COMPLETED',
			storageKey: webglSourceKey,
			sizeBytes: 6_291_456,
			webglUrl: `https://legacy.example.test/api/public/webgl/${archivedProjectId}/`,
		},
		expiresAt: new Date('2525-01-02T00:00:00.000Z'),
	}] satisfies readonly LegacyWebglUploadSession[],
} as const;

const renditionKey = (source: string, profile: 'card-480' | 'display-960') =>
	`${source}/__pcu_image_rendition__/v1/${profile}.webp`;

/** Simulated, successful Garage HEAD responses. Missing deleted/failed sources are intentional. */
export const legacyCanonicalMigrationObjectInventory: readonly LegacyHeadObject[] = [
	{ bucket: 'protected', key: 'uploads/games/2025/legacy-game_한글.zip', mimeType: 'application/zip', size: 4_194_304n, etag: '"legacy-game-etag"', checksumSha256: 'a'.repeat(64) },
	{ bucket: 'protected', key: 'uploads/videos/2025/recording source.mov', mimeType: 'video/quicktime', size: 8_388_608n, etag: '"legacy-video-original-etag"', checksumSha256: 'b'.repeat(64) },
	{ bucket: 'protected', key: 'video/processed/42_002/playback-h264.mp4', mimeType: 'video/mp4', size: 2_097_152n, etag: '"legacy-video-playback-etag"', checksumSha256: 'c'.repeat(64) },
	{ bucket: 'public', key: posterKey, mimeType: 'image/png', size: 512_000n, etag: '"legacy-poster-etag"', checksumSha256: 'd'.repeat(64) },
	{ bucket: 'public', key: renditionKey(posterKey, 'card-480'), mimeType: 'image/webp', size: 42_001n, etag: '"legacy-poster-card-etag"', checksumSha256: 'e'.repeat(64) },
	{ bucket: 'public', key: renditionKey(posterKey, 'display-960'), mimeType: 'image/webp', size: 100_001n, etag: '"legacy-poster-display-etag"', checksumSha256: 'f'.repeat(64) },
	{ bucket: 'public', key: imageKey, mimeType: 'image/webp', size: 200_100n, etag: '"legacy-image-etag"', checksumSha256: '1'.repeat(64) },
	{ bucket: 'public', key: renditionKey(imageKey, 'card-480'), mimeType: 'image/webp', size: 31_000n, etag: '"legacy-image-card-etag"', checksumSha256: '2'.repeat(64) },
	{ bucket: 'public', key: renditionKey(imageKey, 'display-960'), mimeType: 'image/webp', size: 78_000n, etag: '"legacy-image-display-etag"', checksumSha256: '3'.repeat(64) },
	{ bucket: 'protected', key: webglSourceKey, mimeType: 'application/zip', size: 6_291_456n, etag: '"legacy-webgl-source-etag"', checksumSha256: '4'.repeat(64) },
	{ bucket: 'public', key: `${webglPublicPrefix}index.html`, mimeType: 'text/html; charset=utf-8', size: 1_024n, etag: '"legacy-webgl-index-etag"', checksumSha256: '5'.repeat(64) },
	{ bucket: 'public', key: `${webglPublicPrefix}Build/game.loader.js`, mimeType: 'application/javascript', size: 2_048n, etag: '"legacy-webgl-loader-etag"', checksumSha256: '6'.repeat(64) },
	{ bucket: 'public', key: `${webglPublicPrefix}Build/game.wasm.br`, mimeType: 'application/wasm', size: 3_072n, etag: '"legacy-webgl-wasm-etag"', checksumSha256: '7'.repeat(64) },
	{ bucket: 'public', key: exhibitionPosterKey, mimeType: 'image/jpeg', size: 310_001n, etag: '"legacy-exhibition-poster-etag"', checksumSha256: '8'.repeat(64) },
	{ bucket: 'public', key: renditionKey(exhibitionPosterKey, 'card-480'), mimeType: 'image/webp', size: 30_001n, etag: '"legacy-exhibition-card-etag"', checksumSha256: '9'.repeat(64) },
	{ bucket: 'public', key: renditionKey(exhibitionPosterKey, 'display-960'), mimeType: 'image/webp', size: 70_001n, etag: '"legacy-exhibition-display-etag"', checksumSha256: '0'.repeat(64) },
];

/** Expected Phase 1 result, expressed without assuming the eventual Prisma IDs. */
export const legacyCanonicalMigrationExpected = {
	representations: [
		{ legacyAssetId: 42_001, role: 'ORIGINAL', bucket: 'protected', key: 'uploads/games/2025/legacy-game_한글.zip' },
		{ legacyAssetId: 42_002, role: 'ORIGINAL', bucket: 'protected', key: 'uploads/videos/2025/recording source.mov' },
		{ legacyAssetId: 42_002, role: 'PLAYBACK', bucket: 'protected', key: 'video/processed/42_002/playback-h264.mp4' },
		{ legacyAssetId: 42_003, role: 'ORIGINAL', bucket: 'public', key: posterKey },
		{ legacyAssetId: 42_003, role: 'CARD_480', bucket: 'public', key: renditionKey(posterKey, 'card-480') },
		{ legacyAssetId: 42_003, role: 'DISPLAY_960', bucket: 'public', key: renditionKey(posterKey, 'display-960') },
		{ legacyAssetId: 42_004, role: 'ORIGINAL', bucket: 'public', key: imageKey },
		{ legacyAssetId: 42_004, role: 'CARD_480', bucket: 'public', key: renditionKey(imageKey, 'card-480') },
		{ legacyAssetId: 42_004, role: 'DISPLAY_960', bucket: 'public', key: renditionKey(imageKey, 'display-960') },
		{ legacyAssetId: 42_005, role: 'ORIGINAL', bucket: 'protected', key: webglSourceKey },
		{ legacyAssetId: 42_005, role: 'WEBGL_SOURCE', bucket: 'protected', key: webglSourceKey },
	],
	exhibitionPoster: {
		legacyExhibitionId: exhibitionId,
		representations: [
			{ role: 'ORIGINAL', bucket: 'public', key: exhibitionPosterKey },
			{ role: 'CARD_480', bucket: 'public', key: renditionKey(exhibitionPosterKey, 'card-480') },
			{ role: 'DISPLAY_960', bucket: 'public', key: renditionKey(exhibitionPosterKey, 'display-960') },
		],
	},
	webglDeployment: {
		projectId: archivedProjectId,
		sourceAssetId: 42_005,
		sourceUploadSessionId: 'a1017537-6772-4ccd-8e49-4ccf8609a2a1',
		legacyEntryKey: `${webglPublicPrefix}index.html`,
		publicPrefix: webglPublicPrefix,
		objectManifestKeys: [
			`${webglPublicPrefix}Build/game.loader.js`,
			`${webglPublicPrefix}Build/game.wasm.br`,
			`${webglPublicPrefix}index.html`,
		],
		state: 'READY',
	},
	unresolvedWebglDeployment: {
		projectId: unresolvedProjectId,
		legacyEntryKey: `webgl/${unresolvedProjectId}/not-a-generation/index.html`,
		reason: 'MALFORMED_ENTRY_KEY_WITHOUT_COMPLETED_WEBGL_SOURCE',
	},
	noRepresentationForTerminalAssets: [42_006, 42_007],
} as const;

type NumericUpsertDelegate = {
	upsert(input: { where: { id: number }; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<unknown>;
};

type StringUpsertDelegate = {
	upsert(input: { where: { id: string }; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<unknown>;
};

/**
 * Deterministic upserts make this safe to call repeatedly in an isolated
 * migration database. The fixture deliberately does not delete unrelated
 * rows; the caller owns transaction reset/cleanup for its test database.
 */
export async function loadLegacyCanonicalMigrationFixture(client: {
	user: NumericUpsertDelegate;
	exhibition: NumericUpsertDelegate;
	project: NumericUpsertDelegate;
	asset: NumericUpsertDelegate;
	gameUploadSession: StringUpsertDelegate;
}): Promise<void> {
	for (const user of legacyCanonicalMigrationFixture.users) {
		await client.user.upsert({ where: { id: user.id }, create: { ...user }, update: { ...user } });
	}
	for (const exhibition of legacyCanonicalMigrationFixture.exhibitions) {
		await client.exhibition.upsert({ where: { id: exhibition.id }, create: { ...exhibition }, update: { ...exhibition } });
	}
	for (const project of legacyCanonicalMigrationFixture.projects) {
		const {
			posterAssetId: _posterAssetId,
			webglEntryKey: _webglEntryKey,
			...projectWithoutPointers
		} = project;
		await client.project.upsert({
			where: { id: project.id },
			create: { ...projectWithoutPointers, posterAssetId: null, webglEntryKey: '' },
			update: { ...projectWithoutPointers, posterAssetId: null, webglEntryKey: '' },
		});
	}
	for (const asset of legacyCanonicalMigrationFixture.assets) {
		await client.asset.upsert({ where: { id: asset.id }, create: { ...asset }, update: { ...asset } });
	}
	for (const session of legacyCanonicalMigrationFixture.gameUploadSessions) {
		await client.gameUploadSession.upsert({
			where: { id: session.id }, create: { ...session }, update: { ...session },
		});
	}
	for (const project of legacyCanonicalMigrationFixture.projects) {
		await client.project.upsert({
			where: { id: project.id },
			create: { ...project },
			update: {
				posterAssetId: project.posterAssetId,
				webglEntryKey: project.webglEntryKey,
			},
		});
	}
}
