import type { ProjectStatus } from '@prisma/client';
import { forbidden } from '../../../shared/errors.js';
import * as repo from './repository.js';

/**
 * Validate that a status transition is allowed for the given role.
 *
 * - ADMIN / OPERATOR: all transitions allowed.
 * - USER: DRAFT <-> PUBLISHED only. ARCHIVED transitions are blocked.
 */
export function assertStatusTransition(
	currentStatus: string,
	targetStatus: string,
	role: string,
): void {
	if (role === 'ADMIN' || role === 'OPERATOR') return;

	const allowed =
		(currentStatus === 'DRAFT' && targetStatus === 'PUBLISHED') ||
		(currentStatus === 'PUBLISHED' && targetStatus === 'DRAFT');

	if (!allowed) {
		throw forbidden(
			`Users can only toggle between DRAFT and PUBLISHED. Cannot change ${currentStatus} -> ${targetStatus}.`,
		);
	}
}

/** Bulk update project status */
export async function bulkUpdateStatus(ids: number[], status: ProjectStatus) {
	const result = await repo.bulkUpdateStatus(ids, status);
	return { updated: result.count };
}
