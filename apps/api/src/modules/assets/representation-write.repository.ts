import type { AssetKind, Prisma } from '../../generated/prisma/client.js';
import type { CanonicalAssetOwner, CanonicalAssetRepresentationWrite } from './representation.ports.js';
import { validateReadyRepresentations, validateAssetOwner } from './representation.policy.js';
function representationsFor(representations: readonly CanonicalAssetRepresentationWrite[]): Prisma.AssetRepresentationCreateWithoutAssetInput[] {

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
export async function createReadyAssetWithOriginal(
	tx: Prisma.TransactionClient,
	input: CanonicalAssetOwner & {
		kind: AssetKind;
		originalName: string;
		representations: readonly CanonicalAssetRepresentationWrite[];
	},
) {
	validateAssetOwner(input);
	validateReadyRepresentations(input.representations);
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
