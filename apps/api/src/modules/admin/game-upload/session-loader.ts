import { badRequest, forbidden, notFound } from '../../../shared/errors.js';
import type { GameUploadServiceDependencies } from './ports.js';

/** Load and validate a session (ownership, expiry) */
export async function loadSession(
	deps: Pick<
		GameUploadServiceDependencies,
		'clock' | 'logger' | 'repository' | 'storage' | 'wakeMaintenance'
	>,
	sessionId: string,
	userId: number,
	userRole: string,
) {
	const session = await deps.repository.findSessionById(sessionId);
	if (!session) throw notFound('Upload session not found');

	const isPrivileged = userRole === 'ADMIN' || userRole === 'OPERATOR';
	if (!isPrivileged && session.userId !== userId) {
		throw forbidden('Not your upload session');
	}

	if (session.expiresAt < deps.clock.now()) {
		const cancelled = await deps.repository.cancelSessionAndClearActive(session.id);
		// A completion may win after the read above. Only abort the multipart upload
		// when our PENDING -> CANCELLED compare-and-set actually succeeded.
		if (cancelled.count === 1 && cancelled.durableAbort) {
			deps.wakeMaintenance();
			await deps.storage.abortMultipart(
				cancelled.durableAbort.key,
				cancelled.durableAbort.uploadId,
			).catch((err) => {
				deps.logger.error({
					err,
					sessionId: cancelled.durableAbort?.sessionId,
					s3Key: cancelled.durableAbort?.key,
					tracking: cancelled.durableAbort?.tracking,
				}, 'Failed to abort multipart upload for expired session');
			});
		}
		throw badRequest('Upload session has expired');
	}

	return session;
}
