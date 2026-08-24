import type { SavedImageRendition } from '../../application/upload-ports.js';
import type {
	AssetKind,
	AssetPlaybackStatus,
	AssetRepresentationRole,
	Prisma,
} from '../../generated/prisma/client.js';
import { deriveImageRenditionStorageKey } from '../../shared/responsive-image.js';

export interface CanonicalAssetObjectWrite {
	/** Canonical callers name the source bucket explicitly. `bucket` is Phase-1 inline-write compatibility only. */
	originalBucket?: string;
	bucket?: string;
	storageKey: string;
	playbackBucket?: string;
	playbackStorageKey?: string | null;
	originalName: string;
	mimeType: string;
	playbackMimeType?: string;
	sizeBytes: bigint;
	playbackSizeBytes?: bigint;
	playbackStatus?: AssetPlaybackStatus;
	playbackError?: string;
	width?: number;
	height?: number;
	renditions?: readonly SavedImageRendition[];
	isPublic: boolean;
	/** WEBGL sources use the same canonical physical-identity writer with a domain-specific role. */
	originalRole?: Extract<AssetRepresentationRole, 'ORIGINAL' | 'WEBGL_SOURCE'>;
}

export interface CanonicalAssetOwner {
	projectId?: number;
	exhibitionId?: number;
}

function representationsFor(data: CanonicalAssetObjectWrite): Prisma.AssetRepresentationCreateWithoutAssetInput[] {
	const originalBucket = data.originalBucket ?? data.bucket;
	if (!originalBucket) throw new Error('Canonical asset original bucket is required');
	const representations: Prisma.AssetRepresentationCreateWithoutAssetInput[] = [{
		role: data.originalRole ?? 'ORIGINAL',
		bucket: originalBucket,
		objectKey: data.storageKey,
		mimeType: data.mimeType,
		sizeBytes: data.sizeBytes,
		state: 'READY',
		width: data.width,
		height: data.height,
	}];
	if (data.playbackStatus === 'READY') {
		representations.push({
			role: 'PLAYBACK',
			bucket: data.playbackBucket ?? originalBucket,
			objectKey: data.playbackStorageKey ?? data.storageKey,
			mimeType: data.playbackMimeType || data.mimeType || 'video/mp4',
			sizeBytes: data.playbackStorageKey
				? data.playbackSizeBytes ?? 0n
				: data.sizeBytes,
			state: 'READY',
		});
	}
	for (const rendition of data.renditions ?? []) {
		representations.push({
			role: rendition.profile,
			bucket: originalBucket,
			objectKey: deriveImageRenditionStorageKey(data.storageKey, rendition.profile),
			mimeType: 'image/webp',
			state: 'READY',
			width: rendition.width,
			height: rendition.height,
		});
	}
	return representations;
}

/**
 * Phase-1 canonical writer. Physical locators and variant readiness are owned
 * exclusively by representation rows; legacy Asset locator/scalar fields stay
 * null/default for every new write.
 */
export async function createCanonicalAsset(
	tx: Prisma.TransactionClient,
	input: CanonicalAssetOwner & CanonicalAssetObjectWrite & { kind: AssetKind },
) {
	if ((input.projectId === undefined) === (input.exhibitionId === undefined)) {
		throw new Error('Canonical asset must have exactly one domain owner');
	}
	return tx.asset.create({
		data: {
			projectId: input.projectId,
			exhibitionId: input.exhibitionId,
			kind: input.kind,
			status: 'READY',
			storageKey: null,
			playbackStorageKey: null,
			originalName: input.originalName,
			mimeType: input.mimeType,
			sizeBytes: input.sizeBytes,
			playbackMimeType: '',
			playbackSizeBytes: 0n,
			playbackStatus: 'PENDING',
			playbackError: '',
			isPublic: input.isPublic,
			width: input.width,
			height: input.height,
			card480Height: null,
			display960Height: null,
			representations: { create: representationsFor(input) },
		},
		include: { representations: true },
	});
}

export interface PhysicalAssetSnapshot {
	id: number;
	kind: AssetKind;
	storageKey: string | null;
	playbackStorageKey: string | null;
	representations: Array<{
		role: string;
		bucket: string;
		objectKey: string;
	}>;
}
