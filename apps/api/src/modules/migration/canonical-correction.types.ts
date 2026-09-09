import type { CanonicalRepresentationPlan } from './canonical-backfill.types.js';

export type CorrectionKind = 'VIDEO' | 'POSTER' | 'DOCUMENT' | 'ATTACHMENT';
export interface CorrectionSource {
	bucket: string;
	key: string;
	mimeType: string;
	sizeBytes: string;
	sha256: string;
	etag: string | null;
}
/** Operator-supplied evidence is deliberately retained in the reviewed manifest. */
export interface CorrectionCandidate {
	assetId: number | null;
	projectId: number;
	targetKind: CorrectionKind;
	videoSortOrder: number | null;
	originalName: string;
	source: CorrectionSource;
	ownershipEvidence: { description: string; artifact: string; sha256: string } | null;
	/** A byte-identical unreferenced alias of this existing ORIGINAL; do not create another asset. */
	sourceAlias?: boolean;
}
export interface CorrectionOutput extends Omit<CanonicalRepresentationPlan, 'sizeBytes'> {
	sizeBytes: string;
	provenance: { operation: 'COPY' | 'IMAGE_RENDITION' | 'VIDEO_PLAYBACK'; sourceSha256: string };
}
export interface CorrectionItem extends CorrectionCandidate {
	/** A nextval reservation is persisted before creating any object. */
	reservedAssetId?: number;
	outputs: CorrectionOutput[];
}
export interface CorrectionManifest {
	version: 1;
	id: string;
	createdAt: string;
	protectedBucket: string;
	publicBucket: string;
	phase: 'INVESTIGATED' | 'PREPARING' | 'PREPARED' | 'APPLIED';
	items: CorrectionItem[];
	/** Full rows, representations, pointers and active upload reservations. */
	snapshots: Record<string, unknown>;
	preparedAt?: string;
	appliedAt?: string;
}
export interface CorrectionRepository {
	snapshot(projectIds: number[], sourceKeys: string[]): Promise<Record<string, unknown>>;
	reserveAssetId(): Promise<number>;
	protect(item: CorrectionItem, output: CorrectionOutput): Promise<void>;
	materialized(item: CorrectionItem, output: CorrectionOutput): Promise<void>;
	/** Locks all owners before assets/references; commits every item together. */
	apply(manifest: CorrectionManifest, verifyObjects: () => Promise<void>): Promise<'APPLIED' | 'ALREADY_APPLIED'>;
}
export interface CorrectionObjectStore {
	verify(source: CorrectionSource): Promise<void>;
	prepare(item: CorrectionItem, manifest: CorrectionManifest, hooks: {
		beforeCreate(output: CorrectionOutput): Promise<void>;
		afterCreate(output: CorrectionOutput): Promise<void>;
	}): Promise<CorrectionOutput[]>;
}
