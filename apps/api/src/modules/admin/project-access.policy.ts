import type { Actor } from '../../application/http-input.js';
import type { ProjectAccessRecord } from './project-access.ports.js';
import type { UserRole } from '@pcu/contracts';
import { AppError, forbidden } from '../../shared/errors.js';
/** Authoritative upload policy rejection; retains the existing HTTP contract. */
export class ProjectUploadPolicyRejectedError extends AppError {
	constructor(message: string) {
		super(403, message, 'FORBIDDEN');
		this.name = 'ProjectUploadPolicyRejectedError';
	}
}

/** Pure permission check with no adapter dependency. */
export function assertWriteAccess(
	role: UserRole,
	creatorId: number,
	userId: number,
	opts: { isMember?: boolean; isModificationEnabled?: boolean } = {},
): void {
	if (role === 'ADMIN' || role === 'OPERATOR') return;
	if (creatorId !== userId && !opts.isMember) {
		throw forbidden('Not project owner or member');
	}
	if (opts.isModificationEnabled === false) {
		throw new ProjectUploadPolicyRejectedError('Project modifications are closed for this exhibition');
	}
}

/** Ordinary mutations never apply to staging, including staff mutations.
 * Uploads use assertStagingUploadAccess for their separate owner exception. */
export function assertOrdinaryProjectMutationAllowed(project: { isChangeRequestDraft?: boolean }): void {
	if (project.isChangeRequestDraft) {
		throw forbidden('Staged change-request projects cannot be modified through project routes');
	}
}

export function assertStagingUploadAccess(
	actor: Actor,
	project: Pick<
		ProjectAccessRecord,
		| 'changeRequestState'
		| 'changeRequestActorId'
		| 'changeRequestSourceCreatorId'
		| 'changeRequestSourceMemberIds'
	>,
): void {
	const sourceMember = project.changeRequestSourceMemberIds?.includes(actor.id) ?? false;
	if (
		project.changeRequestState !== 'DRAFT' ||
		project.changeRequestActorId !== actor.id ||
		project.changeRequestSourceCreatorId === undefined ||
		(project.changeRequestSourceCreatorId !== actor.id && !sourceMember)
	) {
		throw new ProjectUploadPolicyRejectedError(
			'Only the active change-request owner may upload to this staging project',
		);
	}
}
