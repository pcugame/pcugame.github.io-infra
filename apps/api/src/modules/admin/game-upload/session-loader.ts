import type { UserRole } from '@pcu/contracts';
import { badRequest, forbidden, notFound } from '../../../shared/errors.js';
import type { GameUploadServiceDependencies } from './ports.js';
import { recordGameUploadEvent, safeGameUploadLogContext } from './observability.js';

/** Load and validate a session (ownership, expiry) */
export async function loadSession(
	deps: Pick<
		GameUploadServiceDependencies,
		| 'authorizeProjectWrite'
		| 'clock'
		| 'logger'
		| 'repository'
		| 'storage'
		| 'wakeMaintenance'
	>,
	sessionId: string,
	userId: number,
	userRole: UserRole,
) {
	const session = await deps.repository.findSessionById(sessionId);
	if (!session) throw notFound('Upload session not found');

	const isPrivileged = userRole === 'ADMIN' || userRole === 'OPERATOR';
	if (!isPrivileged && session.userId !== userId) {
		throw forbidden('Not your upload session');
	}
	// Current project membership and exhibition policy must be evaluated before
	// an expired read is allowed to mutate state or trigger object-store cleanup.
	await deps.authorizeProjectWrite({ id: userId, role: userRole }, session.projectId);

	// Expiration closes upload capabilities. Once storage completion has started,
	// the durable recovery/verification workflow must remain observable.
	if (session.status === 'PENDING' && session.expiresAt < deps.clock.now()) {
		const cancelled = await deps.repository.expireSessionAndClearActive(session.id);
		// A completion may win after the read above. Only abort the multipart upload
		// when our PENDING -> CANCELLED compare-and-set actually succeeded.
		if (cancelled.count === 1 && cancelled.durableAbort) {
			deps.wakeMaintenance();
			await deps.storage.abortMultipart(
				cancelled.durableAbort.key,
				cancelled.durableAbort.uploadId,
			).catch((err) => {
				deps.logger.error(safeGameUploadLogContext({
					err,
					sessionId: cancelled.durableAbort?.sessionId,
					action: 'prompt_abort',
					result: 'failed',
				}), 'Failed to abort multipart upload for expired session');
			});
		}
		if (cancelled.count === 1) {
			recordGameUploadEvent(deps, 'upload_session_expired', {
				actorId: userId,
				projectId: session.projectId,
				sessionId: session.id,
				generation: session.multipartGeneration ?? 1,
				result: 'expired',
			});
		}
		throw badRequest('Upload session has expired');
	}

	return session;
}
