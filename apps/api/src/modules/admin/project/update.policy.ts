import type { Actor } from '../../../application/http-input.js';
import { conflict, forbidden } from '../../../shared/errors.js';
import { assertOrdinaryProjectMutationAllowed, assertWriteAccess } from '../project-access.policy.js';
import type { ProjectUpdatePatch, ProjectUpdateSnapshot } from './update.ports.js';

export function assertStatusTransition(_currentStatus: string, targetStatus: string, role: string): void {
	if (role === 'ADMIN' || role === 'OPERATOR') return;
	throw forbidden(`Users cannot change project status to ${targetStatus}.`);
}

export function assertProjectUpdateAllowed(snapshot: ProjectUpdateSnapshot, patch: ProjectUpdatePatch, actor: Actor): void {
	assertWriteAccess(actor.role, snapshot.creatorId, actor.id, snapshot);
	assertOrdinaryProjectMutationAllowed(snapshot);
	if (patch.status !== undefined) {
		assertStatusTransition(snapshot.status, patch.status, actor.role);
		if (snapshot.status === 'DRAFT' && patch.status !== 'DRAFT') {
			throw conflict('Draft submissions may only be published by submission finalize');
		}
	}
}
