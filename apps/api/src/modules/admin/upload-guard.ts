import type { Year } from '@prisma/client';
import type { UserRole } from '@prisma/client';
import { notFound, forbidden } from '../../shared/errors.js';

/**
 * Validate that a year exists and that the user is allowed to upload to it.
 *
 * Policy:
 * - Year must exist (operators create years explicitly).
 * - If `isUploadEnabled` is false, only ADMIN / OPERATOR may submit.
 * - USER role is blocked when uploads are disabled.
 */
export function assertUploadAllowed(
	year: Year | null,
	yearNum: number,
	role: UserRole,
): asserts year is Year {
	if (!year) {
		throw notFound(`Year ${yearNum} does not exist. An operator must create it first.`);
	}

	const isPrivileged = role === 'ADMIN' || role === 'OPERATOR';
	if (!year.isUploadEnabled && !isPrivileged) {
		throw forbidden(
			`Upload is disabled for year ${yearNum}. Contact an operator to enable it.`,
		);
	}
}
