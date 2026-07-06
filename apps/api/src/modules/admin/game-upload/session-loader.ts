import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import { abortMultipartUpload } from '../../../lib/storage.js';
import { badRequest, forbidden, notFound } from '../../../shared/errors.js';
import * as repo from './repository.js';

/** Load and validate a session (ownership, expiry) */
export async function loadSession(sessionId: string, userId: number, userRole: string) {
	const session = await repo.findSessionById(sessionId);
	if (!session) throw notFound('Upload session not found');

	const isPrivileged = userRole === 'ADMIN' || userRole === 'OPERATOR';
	if (!isPrivileged && session.userId !== userId) {
		throw forbidden('Not your upload session');
	}

	if (session.expiresAt < new Date()) {
		await repo.cancelSessionAndClearActive(session.id);
		if (session.s3UploadId && session.s3Key) {
			await abortMultipartUpload(env().S3_BUCKET_PROTECTED, session.s3Key, session.s3UploadId).catch((err) => {
				logger().error({ err, sessionId: session.id, s3Key: session.s3Key }, 'Failed to abort multipart upload for expired session');
			});
		}
		throw badRequest('Upload session has expired');
	}

	return session;
}
