import type { GameUploadChunkResponse } from '@pcu/contracts';
import { AppError, badRequest, conflict, operationInProgress } from '../../../shared/errors.js';
import { createCountedChunkStream } from './chunk-stream.js';
import { loadSession } from './session-loader.js';
import { assertGameUploadSessionWritable } from './session-policy.js';
import type { GameUploadServiceDependencies } from './ports.js';

async function abortUnusedReplacement(
	deps: GameUploadServiceDependencies,
	key: string,
	uploadId: string,
	reason: string,
): Promise<void> {
	try {
		await deps.storage.abortMultipart(key, uploadId);
	} catch (error) {
		try {
			if (!deps.repository.queueAbortTask) throw new Error('Multipart abort queue is unavailable');
			await deps.repository.queueAbortTask({ key, uploadId, reason });
		} catch (queueError) {
			deps.logger.error(
				{ error, queueError, key, uploadId },
				'Failed to abort or durably queue unused replacement multipart upload',
			);
		}
	}
}

async function resetGeneration(
	deps: GameUploadServiceDependencies,
	session: { id: string; s3Key: string; s3UploadId: string; multipartGeneration?: number },
	reason: string,
): Promise<boolean> {
	if (!deps.repository.replaceMultipartGeneration) return false;
	const generation = session.multipartGeneration ?? 1;
	const nextUploadId = await deps.storage.createMultipart(session.s3Key);
	const reset = await deps.repository.replaceMultipartGeneration({
		sessionId: session.id,
		expectedGeneration: generation,
		newUploadId: nextUploadId,
		reason,
	});
	if (!reset.replaced) {
		await abortUnusedReplacement(
			deps,
			session.s3Key,
			nextUploadId,
			'unused-generation-reset-upload',
		);
		return false;
	}
	// The transaction already queued the old upload durably. This only reduces
	// storage residue promptly.
	await deps.storage.abortMultipart(session.s3Key, session.s3UploadId).catch((error) => {
		deps.logger.error(
			{ error, sessionId: session.id, s3Key: session.s3Key },
			'Best-effort abort failed after multipart generation reset; durable task retained',
		);
	});
	return true;
}

/** Upload one chunk as an S3 multipart part */
export async function uploadChunk(
	deps: GameUploadServiceDependencies,
	sessionId: string,
	chunkIndex: number,
	body: NodeJS.ReadableStream,
	user: { id: number; role: string },
): Promise<GameUploadChunkResponse> {
	deps.uploadSlots.acquire();
	let claimHeartbeat: NodeJS.Timeout | undefined;
	try {
		const session = await loadSession(deps, sessionId, user.id, user.role);

		if (session.status !== 'PENDING') {
			throw badRequest(`Cannot upload chunks: session is ${session.status}`);
		}
		assertGameUploadSessionWritable(session.project.status, user.role);

		if (isNaN(chunkIndex) || chunkIndex < 0 || chunkIndex >= session.totalChunks) {
			throw badRequest(`Invalid chunk index: must be 0..${session.totalChunks - 1}`);
		}

		if (!session.s3UploadId || !session.s3Key) {
			throw new AppError(500, 'Session is missing S3 multipart info', 'INTERNAL_ERROR');
		}

		const isLastChunk = chunkIndex === session.totalChunks - 1;
		const expectedSize = isLastChunk
			? Number(session.totalBytes) - chunkIndex * session.chunkSizeBytes
			: session.chunkSizeBytes;

		const partNumber = chunkIndex + 1;
		const generation = session.multipartGeneration ?? 1;
		let claimToken: string | undefined;
		if (deps.repository.acquirePartClaim) {
			claimToken = deps.ids.next();
			const now = deps.clock.now();
			const claim = await deps.repository.acquirePartClaim({
				sessionId: session.id,
				partNumber,
				generation,
				token: claimToken,
				owner: `user:${user.id}`,
				now,
				leaseUntil: new Date(now.getTime() + 2 * 60 * 1000),
			});
			if (claim.kind === 'busy') {
				throw operationInProgress(`Chunk ${chunkIndex} is already being uploaded`);
			}
			if (claim.kind === 'expired') {
				if (!deps.repository.replaceMultipartGeneration) {
					throw conflict('An earlier chunk upload expired; create a new upload session');
				}
				await resetGeneration(deps, {
					id: session.id,
					s3Key: session.s3Key,
					s3UploadId: session.s3UploadId,
					multipartGeneration: generation,
				}, 'expired-part-claim-generation-reset');
				throw conflict('A stale chunk upload was isolated; all chunks must be uploaded again');
			}
			if (claim.kind === 'unavailable') {
				throw badRequest('Upload session changed before the chunk claim was acquired');
			}
			if (deps.repository.renewPartClaim) {
				claimHeartbeat = setInterval(() => {
					const heartbeatNow = deps.clock.now();
					void deps.repository.renewPartClaim!(
						claimToken!,
						heartbeatNow,
						new Date(heartbeatNow.getTime() + 2 * 60 * 1000),
					).catch((error) => deps.logger.error(
						{ error, sessionId: session.id, partNumber },
						'Part-upload claim heartbeat failed',
					));
				}, 30 * 1000);
				claimHeartbeat.unref();
			}
		}
		const countedBody = createCountedChunkStream(body, chunkIndex, expectedSize);

		let etag: string;
		try {
			etag = await deps.storage.uploadPart(
				session.s3Key,
				session.s3UploadId,
				partNumber,
				countedBody.stream,
				expectedSize,
			);
		} catch (err) {
			countedBody.destroy(err);
			throw err;
		}
		const bytesWritten = countedBody.bytesWritten();
		if (bytesWritten !== expectedSize) {
			throw badRequest(`Chunk ${chunkIndex}: expected ${expectedSize} bytes, got ${bytesWritten}`);
		}

		let parts;
		if (claimToken && deps.repository.completePartClaim) {
			const completed = await deps.repository.completePartClaim({
				token: claimToken,
				etag,
				now: deps.clock.now(),
			});
			if (!completed.accepted) {
				await resetGeneration(deps, {
					id: session.id,
					s3Key: session.s3Key,
					s3UploadId: session.s3UploadId,
					multipartGeneration: generation,
				}, 'part-claim-expired-before-etag-commit').catch((error) => {
					deps.logger.error(
						{ error, sessionId: session.id, partNumber },
						'Immediate multipart generation reset failed; maintenance will retry',
					);
				});
				throw conflict('Chunk claim expired; the multipart generation must be restarted');
			}
			parts = completed.parts;
		} else {
			parts = await deps.repository.upsertPartEtag(session.id, partNumber, etag);
		}

		return {
			index: chunkIndex,
			bytesWritten,
			uploadedCount: parts.length,
			totalChunks: session.totalChunks,
		};
	} finally {
		if (claimHeartbeat) clearInterval(claimHeartbeat);
		deps.uploadSlots.release();
	}
}
