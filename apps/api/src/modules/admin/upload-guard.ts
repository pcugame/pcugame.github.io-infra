import type { Exhibition } from '@prisma/client';
import type { UserRole } from '@prisma/client';
import { notFound, forbidden } from '../../shared/errors.js';

/**
 * Validate that an exhibition exists and that the user is allowed to upload to it.
 *
 * Policy:
 * - Exhibition must exist (operators create exhibitions explicitly).
 * - If `isUploadEnabled` is false, only ADMIN / OPERATOR may submit.
 * - USER role is blocked when uploads are disabled.
 */
export function assertUploadAllowed(
	exhibition: Exhibition | null,
	exhibitionIdentifier: string | number,
	role: UserRole,
): asserts exhibition is Exhibition {
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
