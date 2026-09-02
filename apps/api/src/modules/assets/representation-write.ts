import type {
	AssetKind,
	AssetRepresentationRole,
	AssetRepresentationState,
	Prisma,
} from '../../generated/prisma/client.js';

export interface CanonicalAssetRepresentationWrite {
	role: AssetRepresentationRole;
	bucket: string;
	objectKey: string;
	mimeType: string;
	sizeBytes: bigint;
	state: AssetRepresentationState;
	width?: number;
	height?: number;
	checksumAlgorithm?: string;
	checksum?: string;
	etag?: string;
	sourceIdentityAlgorithm?: string;
	sourceIdentity?: string;
	error?: string;
}

export interface CanonicalAssetOwner {
	projectId?: number;
	exhibitionId?: number;
}

function failInvalidRepresentation(message: string): never {
	throw new Error(`Canonical asset representation invalid: ${message}`);
}

function representationsFor(
	representations: readonly CanonicalAssetRepresentationWrite[],
): Prisma.AssetRepresentationCreateWithoutAssetInput[] {
	if (representations.length === 0) failInvalidRepresentation('at least one representation is required');
	const roles = new Set<string>();
	let original: CanonicalAssetRepresentationWrite | undefined;
	for (const representation of representations) {
		if (!representation.role || roles.has(representation.role)) {
			failInvalidRepresentation(`duplicate or empty role ${String(representation.role)}`);
		}
		roles.add(representation.role);
		if (!representation.bucket.trim() || !representation.objectKey.trim() || !representation.mimeType.trim()) {
			failInvalidRepresentation(`role ${representation.role} requires bucket, objectKey, and mimeType`);
		}
		if (representation.sizeBytes < 0n) failInvalidRepresentation(`role ${representation.role} has a negative size`);
		if ((representation.width !== undefined && representation.width <= 0)
			|| (representation.height !== undefined && representation.height <= 0)) {
			failInvalidRepresentation(`role ${representation.role} has invalid dimensions`);
		}
		if (representation.role === 'ORIGINAL') original = representation;
	}
	if (!original) failInvalidRepresentation('ORIGINAL representation is required');
	if (original.state !== 'READY') failInvalidRepresentation('ORIGINAL representation must be READY');

	return representations.map((representation) => ({
		role: representation.role,
		storageBucket: { connect: { bucket: representation.bucket } },
		objectKey: representation.objectKey,
		mimeType: representation.mimeType,
		sizeBytes: representation.sizeBytes,
		state: representation.state,
		...(representation.width !== undefined ? { width: representation.width } : {}),
		...(representation.height !== undefined ? { height: representation.height } : {}),
		...(representation.checksumAlgorithm !== undefined ? { checksumAlgorithm: representation.checksumAlgorithm } : {}),
		...(representation.checksum !== undefined ? { checksum: representation.checksum } : {}),
		...(representation.etag !== undefined ? { etag: representation.etag } : {}),
		...(representation.sourceIdentityAlgorithm !== undefined ? { sourceIdentityAlgorithm: representation.sourceIdentityAlgorithm } : {}),
		...(representation.sourceIdentity !== undefined ? { sourceIdentity: representation.sourceIdentity } : {}),
		...(representation.error !== undefined ? { error: representation.error } : {}),
	}));
}

/**
 * Asset owns only domain identity. Every physical object and variant is an
 * explicit caller-supplied representation; this adapter never derives keys or
 * interprets nullable legacy transport fields.
 */
export async function createCanonicalAsset(
	tx: Prisma.TransactionClient,
	input: CanonicalAssetOwner & {
		kind: AssetKind;
		originalName: string;
		representations: readonly CanonicalAssetRepresentationWrite[];
	},
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
			originalName: input.originalName,
			representations: { create: representationsFor(input.representations) },
		},
		include: { representations: true },
	});
}
