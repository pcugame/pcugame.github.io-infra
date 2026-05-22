import type { ProjectStatus } from '@prisma/client';
import { forbidden } from '../../../shared/errors.js';
import * as repo from './repository.js';

/**
 * Validate that a status transition is allowed for the given role.
 *
 * - ADMIN / OPERATOR: all transitions allowed.
 * - USER: status changes are blocked.
 */
export function assertStatusTransition(
	_currentStatus: string,
	targetStatus: string,
	role: string,
): void {
	if (role === 'ADMIN' || role === 'OPERATOR') return;

	throw forbidden(`Users cannot change project status to ${targetStatus}.`);
}

/** Bulk update project status */
export async function bulkUpdateStatus(ids: number[], status: ProjectStatus) {
	const result = await repo.bulkUpdateStatus(ids, status);
	return { updated: result.count };
}
