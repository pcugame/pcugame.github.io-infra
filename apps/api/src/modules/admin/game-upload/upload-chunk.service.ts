import type { GameUploadChunkResponse } from '@pcu/contracts';
import { AppError, badRequest, conflict, operationInProgress } from '../../../shared/errors.js';
import { loadSession } from './session-loader.js';
import { assertGameUploadSessionWritable } from './session-policy.js';
import type { GameUploadServiceDependencies } from './ports.js';
import {
	aggregateBusinessAndCleanupError,
	cleanupUntrackedMultipart,
	MultipartBusinessCleanupError,
	UntrackedMultipartCleanupError,
} from './multipart-cleanup.js';
import { createClaimHeartbeatGuard } from '../../upload-lifecycle/claim-heartbeat.js';
import { Readable } from 'node:stream';
import {
	assertChunkMatchesManifest,
	assertSourceIdentityMatches,
} from './source-identity.js';

async function readValidatedChunk(
	body: NodeJS.ReadableStream,
	chunkIndex: number,
	expectedSize: number,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let written = 0;
	for await (const value of body as AsyncIterable<Buffer | Uint8Array | string>) {
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		written += chunk.length;
		if (written > expectedSize) {
			(body as { destroy?: (error?: Error) => void }).destroy?.();
			throw new AppError(413, `Chunk ${chunkIndex} exceeds expected size`, 'PAYLOAD_TOO_LARGE');
		}
		chunks.push(chunk);
	}
	if (written !== expectedSize) {
		throw badRequest(`Chunk ${chunkIndex}: expected ${expectedSize} bytes, got ${written}`);
	}
	return Buffer.concat(chunks, expectedSize);
}

async function abortUnusedReplacement(
	deps: GameUploadServiceDependencies,
	key: string,
	uploadId: string,
	reason: string,
): Promise<void> {
	await cleanupUntrackedMultipart(deps, { key, uploadId, reason });
}

async function resetGeneration(
	deps: GameUploadServiceDependencies,
	session: { id: string; s3Key: string; s3UploadId: string; multipartGeneration?: number },
	reason: string,
): Promise<boolean> {
	const generation = session.multipartGeneration ?? 1;
	const nextUploadId = await deps.storage.createMultipart(session.s3Key);
	let reset: Awaited<ReturnType<typeof deps.repository.replaceMultipartGeneration>>;
	try {
		reset = await deps.repository.replaceMultipartGeneration({
			sessionId: session.id,
			expectedGeneration: generation,
			newUploadId: nextUploadId,
			reason,
		});
	} catch (businessError) {
		try {
			await cleanupUntrackedMultipart(deps, {
				key: session.s3Key,
				uploadId: nextUploadId,
				reason: 'generation-reset-persistence-failed',
			});
		} catch (cleanupError) {
			if (cleanupError instanceof UntrackedMultipartCleanupError) {
				throw aggregateBusinessAndCleanupError(
					businessError,
					cleanupError,
					'Multipart generation replacement and cleanup both failed',
				);
			}
			throw cleanupError;
		}
		throw businessError;
	}
	if (!reset.replaced) {
		await abortUnusedReplacement(
			deps,
			session.s3Key,
			nextUploadId,
			'unused-generation-reset-upload',
		);
		return false;
	}
	const durableAbort = reset.durableAbort;
	if (durableAbort) {
		// The discriminated result proves the transaction committed the exact old
		// upload to the abort outbox before this prompt, best-effort abort.
		deps.wakeMaintenance();
		await deps.storage.abortMultipart(
			durableAbort.key,
			durableAbort.uploadId,
		).catch((error) => {
			deps.logger.error(
				{
					error,
					sessionId: durableAbort.sessionId,
					s3Key: durableAbort.key,
					tracking: durableAbort.tracking,
				},
				'Best-effort abort failed after multipart generation reset; durable task retained',
			);
		});
	}
	return true;
}

/** Upload one chunk as an S3 multipart part */
export async function uploadChunk(
	deps: GameUploadServiceDependencies,
	sessionId: string,
	chunkIndex: number,
	body: NodeJS.ReadableStream,
	user: { id: number; role: string },
	query: { sourceIdentityAlgorithm?: string; sourceIdentity?: string },
): Promise<GameUploadChunkResponse> {
	deps.uploadSlots.acquire();
	let claimHeartbeat: ReturnType<typeof createClaimHeartbeatGuard> | undefined;
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
		assertSourceIdentityMatches(session, query);
		const chunkBuffer = await readValidatedChunk(body, chunkIndex, expectedSize);
		const contentSha256 = assertChunkMatchesManifest({
			buffer: chunkBuffer,
			chunkIndex,
			chunkSizeBytes: session.chunkSizeBytes,
			manifest: session.sourceIdentityBlockManifest!,
		});
		const claimToken = deps.ids.next();
		const claim = await deps.repository.acquirePartClaim({
			sessionId: session.id,
			partNumber,
			generation,
			token: claimToken,
			owner: `user:${user.id}`,
			leaseMs: 2 * 60 * 1000,
			contentSha256,
		});
		if (claim.kind === 'already-uploaded') {
			return {
				index: chunkIndex,
				bytesWritten: expectedSize,
				uploadedCount: claim.parts.length,
				totalChunks: session.totalChunks,
			};
		}
		if (claim.kind === 'conflict') {
			throw conflict('Chunk content does not match the previously uploaded chunk', {
				reason: 'CHUNK_CONTENT_MISMATCH',
			});
		}
		if (claim.kind === 'busy') {
			throw operationInProgress(`Chunk ${chunkIndex} is already being uploaded`);
		}
		if (claim.kind === 'expired') {
			const businessError = conflict('A stale chunk upload was isolated; all chunks must be uploaded again');
			try {
				await resetGeneration(deps, {
					id: session.id,
					s3Key: session.s3Key,
					s3UploadId: session.s3UploadId,
					multipartGeneration: generation,
				}, 'expired-part-claim-generation-reset');
			} catch (cleanupError) {
				if (cleanupError instanceof UntrackedMultipartCleanupError) {
					throw aggregateBusinessAndCleanupError(
						businessError,
						cleanupError,
						'Expired chunk claim and replacement cleanup both failed',
					);
				}
				throw cleanupError;
			}
			throw businessError;
		}
		if (claim.kind === 'unavailable') {
			throw badRequest('Upload session changed before the chunk claim was acquired');
		}
		claimHeartbeat = createClaimHeartbeatGuard({
			heartbeatMs: 30 * 1000,
			lostMessage: `Part-upload claim was lost for session ${session.id}, part ${partNumber}`,
			renew: () => deps.repository.renewPartClaim(claimToken, 2 * 60 * 1000),
			logHeartbeatFailure: (error) => deps.logger.error(
				{ error, sessionId: session.id, partNumber },
				'Part-upload claim heartbeat failed',
			),
		});
		let etag: string;
		try {
			etag = await deps.storage.uploadPart(
				session.s3Key,
				session.s3UploadId,
				partNumber,
				Readable.from(chunkBuffer),
				expectedSize,
				{ signal: claimHeartbeat.signal },
			);
		} catch (err) {
			if (claimHeartbeat.isLost()) {
				await claimHeartbeat.assertOwned();
			}
			throw err;
		}
		await claimHeartbeat.assertOwned();
		const bytesWritten = expectedSize;

		let parts;
		const completed = await deps.repository.completePartClaim({
			token: claimToken,
			etag,
			contentSha256,
		});
		if (completed.conflict) {
			throw conflict('Chunk content does not match the previously uploaded chunk', {
				reason: 'CHUNK_CONTENT_MISMATCH',
			});
		}
		if (!completed.accepted) {
			const businessError = conflict('Chunk claim expired; the multipart generation must be restarted');
			try {
				await resetGeneration(deps, {
					id: session.id,
					s3Key: session.s3Key,
					s3UploadId: session.s3UploadId,
					multipartGeneration: generation,
				}, 'part-claim-expired-before-etag-commit');
			} catch (error) {
				if (error instanceof UntrackedMultipartCleanupError) {
					throw aggregateBusinessAndCleanupError(
						businessError,
						error,
						'Chunk claim expiration and replacement cleanup both failed',
					);
				}
				if (error instanceof MultipartBusinessCleanupError) throw error;
				deps.logger.error(
					{ error, sessionId: session.id, partNumber },
					'Immediate multipart generation reset failed; maintenance will retry',
				);
			}
			throw businessError;
		}
		parts = completed.parts;

		return {
			index: chunkIndex,
			bytesWritten,
			uploadedCount: parts.length,
			totalChunks: session.totalChunks,
		};
	} finally {
		claimHeartbeat?.stop();
		deps.uploadSlots.release();
	}
}
