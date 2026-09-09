export type CanonicalBackfillMode = 'dry-run' | 'apply';
export type CanonicalBackfillPhase = 'assets' | 'exhibitions' | 'webgl' | 'done';
export type CanonicalWorkKind = 'asset' | 'exhibition' | 'webgl';

export interface CanonicalWorkRef {
	kind: CanonicalWorkKind;
	id: number;
}

export type CanonicalFailureCode =
	| 'MISSING_OBJECT'
	| 'AMBIGUOUS_OBJECT'
	| 'WRONG_BUCKET'
	| 'MALFORMED_LEGACY_ROW'
	| 'SOURCE_NOT_PROVEN'
	| 'CONCURRENT_CHANGE'
	| 'CANONICAL_CONFLICT'
	| 'OBJECT_HEAD_FAILED'
	| 'COPY_FAILED'
	| 'COPY_CONFLICT'
	| 'REPAIR_REQUIRED'
	| 'REPAIR_FAILED';

export interface CanonicalBackfillFailure {
	ref: CanonicalWorkRef;
	code: CanonicalFailureCode;
	message: string;
	at: string;
}

export interface CanonicalBackfillProgress {
	version: 1;
	mode: CanonicalBackfillMode;
	phase: CanonicalBackfillPhase;
	afterId: number;
	pendingFailures: CanonicalBackfillFailure[];
	updatedAt: string;
}

export interface ObjectHeadRecord {
	size: bigint;
	mimeType: string;
	etag?: string;
	checksumSha256?: string;
}

export interface CanonicalObjectHeadVerifier {
	head(bucket: string, key: string): Promise<ObjectHeadRecord | null>;
	listPrefix(
		bucket: string,
		prefix: string,
		afterKey: string | undefined,
		limit: number,
	): Promise<{ keys: string[]; isTruncated: boolean }>;
}

export interface CanonicalWebglSourceCopy {
	sourceBucket: string;
	sourceKey: string;
	destinationBucket: string;
	destinationKey: string;
	expected: ObjectHeadRecord;
}

export interface CanonicalObjectCopy {
	sourceBucket: string;
	sourceKey: string;
	destinationBucket: string;
	destinationKey: string;
	expected: ObjectHeadRecord;
}

export interface CanonicalObjectRelocation {
	workKind: CanonicalWorkKind;
	workRef: string;
	role: string;
	copy: CanonicalObjectCopy;
	verified: ObjectHeadRecord;
}

export interface CanonicalImageRepair {
	sourceBucket: string;
	sourceKey: string;
	sourceMimeType: string;
	sourceSizeBytes: bigint;
	missing: Array<{
		role: 'CARD_480' | 'DISPLAY_960';
		width: 480 | 960;
		objectKey: string;
	}>;
}

export interface CanonicalMaterializationTarget {
	bucket: string;
	objectKey: string;
	reason: string;
}

export interface CanonicalMaterializationHooks {
	/** Persist cleanup intent before the first byte is created. */
	beforeCreate(target: CanonicalMaterializationTarget): Promise<void>;
}

/**
 * Migration-only object materializer. It is intentionally absent from the
 * Fastify graph and may read/copy bytes under bounded worker-style limits.
 */
export interface CanonicalObjectMaterializer {
	ensureCanonicalObjectCopy(copy: CanonicalObjectCopy, hooks?: CanonicalMaterializationHooks): Promise<{
		head: ObjectHeadRecord;
		created: boolean;
	}>;
	ensureWebglSourceCopy(copy: CanonicalWebglSourceCopy, hooks?: CanonicalMaterializationHooks): Promise<{
		head: ObjectHeadRecord;
		created: boolean;
	}>;
	ensureImageRenditions(repair: CanonicalImageRepair, hooks?: CanonicalMaterializationHooks): Promise<{
		representations: CanonicalRepresentationPlan[];
		created: number;
		reused: number;
	}>;
}

export type LegacyAssetKind = 'THUMBNAIL' | 'IMAGE' | 'POSTER' | 'GAME' | 'VIDEO' | 'WEBGL' | 'DOCUMENT' | 'ATTACHMENT';

export interface LegacyAssetRow {
	id: number;
	projectId: number | null;
	exhibitionId: number | null;
	kind: LegacyAssetKind;
	status: string;
	storageKey: string | null;
	playbackStorageKey: string | null;
	originalName: string;
	mimeType: string;
	playbackMimeType: string;
	sizeBytes: bigint;
	playbackSizeBytes: bigint;
	playbackStatus: string;
	isPublic: boolean;
	width: number | null;
	height: number | null;
	card480Height: number | null;
	display960Height: number | null;
	updatedAt: Date;
	/** A prior run already installed every required READY representation in its final namespace. */
	canonicalBackfillComplete?: boolean;
}

export interface LegacyExhibitionRow {
	id: number;
	posterAssetId: number | null;
	posterStorageKey: string | null;
	posterOriginalName: string;
	posterMimeType: string;
	posterSizeBytes: bigint;
	posterWidth: number | null;
	posterHeight: number | null;
	posterCard480Height: number | null;
	posterDisplay960Height: number | null;
	updatedAt: Date;
}

export interface LegacyWebglSourceProof {
	sessionId: string;
	deploymentId: string;
	storageKey: string;
	originalName: string;
	totalBytes: bigint;
	updatedAt: Date;
}

export interface LegacyWebglRow {
	id: number;
	webglEntryKey: string;
	currentWebglDeploymentId: string | null;
	updatedAt: Date;
	sourceProof: LegacyWebglSourceProof | null;
	sourceLegacyAssetId: number | null;
	sourceLegacyAssetKind: 'GAME' | 'WEBGL' | null;
	/** Existing legacy rows claim the source key, but cannot prove one valid owner. */
	sourceOwnershipConflict?: boolean;
}

export type CanonicalRepresentationRole =
	| 'ORIGINAL'
	| 'PLAYBACK'
	| 'CARD_480'
	| 'DISPLAY_960'
	| 'WEBGL_SOURCE';

export interface CanonicalRepresentationPlan {
	role: CanonicalRepresentationRole;
	bucket: string;
	objectKey: string;
	mimeType: string;
	sizeBytes: bigint;
	checksumAlgorithm: string | null;
	checksum: string | null;
	etag: string | null;
	sourceIdentityAlgorithm: string | null;
	sourceIdentity: string | null;
	width: number | null;
	height: number | null;
}

export interface CanonicalAssetPlan {
	row: LegacyAssetRow;
	representations: CanonicalRepresentationPlan[];
	imageRepair: CanonicalImageRepair | null;
	relocations?: CanonicalObjectRelocation[];
}

export interface CanonicalExhibitionPlan {
	row: LegacyExhibitionRow;
	representations: CanonicalRepresentationPlan[];
	imageRepair: CanonicalImageRepair | null;
	relocations?: CanonicalObjectRelocation[];
}

export interface CanonicalWebglPlan {
	row: LegacyWebglRow;
	deploymentId: string;
	publicBucket: string;
	publicPrefix: string;
	entryObjectKey: string;
	source: CanonicalRepresentationPlan;
	sourceCopy: CanonicalWebglSourceCopy | null;
	relocations?: CanonicalObjectRelocation[];
	entry: ObjectHeadRecord;
	objectManifest: {
		version: 1;
		objects: Array<{
			objectKey: string;
			sizeBytes: string;
			mimeType: string;
			etag: string | null;
			checksumSha256: string | null;
		}>;
	};
}

export interface CanonicalApplyOutcome {
	assetsCreated: number;
	representationsUpserted: number;
	deploymentsUpserted: number;
}

export interface CanonicalBackfillRepository {
	listAssets(afterId: number, limit: number): Promise<LegacyAssetRow[]>;
	listExhibitions(afterId: number, limit: number): Promise<LegacyExhibitionRow[]>;
	listWebglProjects(afterId: number, limit: number): Promise<LegacyWebglRow[]>;
	getAsset(id: number): Promise<LegacyAssetRow | null>;
	getExhibition(id: number): Promise<LegacyExhibitionRow | null>;
	getWebglProject(id: number): Promise<LegacyWebglRow | null>;
	prepareMaterializationCleanup(target: CanonicalMaterializationTarget): Promise<void>;
	prepareObjectRelocation(relocation: Omit<CanonicalObjectRelocation, 'verified'>): Promise<void>;
	markObjectRelocationMaterialized(relocation: CanonicalObjectRelocation): Promise<void>;
	applyAsset(plan: CanonicalAssetPlan): Promise<CanonicalApplyOutcome>;
	applyExhibition(plan: CanonicalExhibitionPlan): Promise<CanonicalApplyOutcome>;
	applyWebgl(plan: CanonicalWebglPlan): Promise<CanonicalApplyOutcome>;
}

export interface CanonicalBackfillOptions {
	apply: boolean;
	batchSize: number;
}

export interface CanonicalBackfillStats {
	scanned: number;
	eligible: number;
	skipped: number;
	assetsCreated: number;
	representations: number;
	deployments: number;
	objectCopies: number;
	objectsReused: number;
	imageRepairs: number;
	repairsPlanned: number;
	objectCopiesPlanned: number;
	failures: number;
}

export interface CanonicalBackfillResult {
	mode: CanonicalBackfillMode;
	stats: CanonicalBackfillStats;
	progress: CanonicalBackfillProgress;
	failures: CanonicalBackfillFailure[];
}
