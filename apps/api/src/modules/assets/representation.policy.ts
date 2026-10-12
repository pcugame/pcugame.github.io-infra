import type { CanonicalAssetRepresentationWrite, CanonicalAssetOwner } from './representation.ports.js';
function failInvalidRepresentation(message: string): never {
	throw new Error(`Canonical asset representation invalid: ${message}`);
}

export function validateReadyRepresentations(
	representations: readonly CanonicalAssetRepresentationWrite[],
): void {
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

}

export function validateAssetOwner(input: CanonicalAssetOwner): void {
 if ((input.projectId === undefined) === (input.exhibitionId === undefined)) {
  throw new Error('Canonical asset must have exactly one domain owner');
 }
}
