import type { UserRole } from '@pcu/contracts';
import { notFound, forbidden } from '../../shared/errors.js';

export interface UploadableExhibition {
	id: number;
	year: number;
	title: string;
	isUploadEnabled: boolean;
}

/**
 * Validate that an exhibition exists and that the user is allowed to upload to it.
 *
 * Policy:
 * - Exhibition must exist (operators create exhibitions explicitly).
 * - If `isUploadEnabled` is false, only ADMIN / OPERATOR may submit.
 * - USER role is blocked when uploads are disabled.
 */
export function assertUploadAllowed(
	exhibition: UploadableExhibition | null,
	exhibitionIdentifier: string | number,
	role: UserRole,
): asserts exhibition is UploadableExhibition {
	if (!exhibition) {
		throw notFound(`Exhibition ${exhibitionIdentifier} does not exist. An operator must create it first.`);
	}

	const isPrivileged = role === 'ADMIN' || role === 'OPERATOR';
	if (!exhibition.isUploadEnabled && !isPrivileged) {
		const label = exhibition.title ? `"${exhibition.title}" (${exhibition.year})` : String(exhibition.year);
		throw forbidden(
			`Upload is disabled for ${label}. Contact an operator to enable it.`,
		);
	}
}
