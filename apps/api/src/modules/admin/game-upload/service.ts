/**
 * Resumable chunked game-file upload service (S3 multipart).
 *
 * Flow:
 *   1. createSession()    -> create S3 multipart upload + DB session
 *   2. uploadChunk()      -> upload one S3 part
 *   3. getSessionStatus() -> query progress
 *   4. completeSession()  -> complete multipart upload -> GAME asset
 *   5. cancelSession()    -> abort multipart upload + cleanup
 */

export { createCountedChunkStream, chunkByteLength, toError } from './chunk-stream.js';
export { assertGameUploadSessionWritable } from './session-policy.js';
export { chunkUploadBodyLimitBytes, resolveChunkSizeBytes } from './session-sizing.js';

import { createSession } from './create-session.service.js';
import { authorizeLegacyChunkUpload, uploadChunk } from './upload-chunk.service.js';
import { completeSession } from './complete-session.service.js';
import { signPartUrls } from './sign-part-urls.service.js';
import {
	cancelSession,
	getSessionStatus,
	listSessions,
	sweepExpiredPendingSessions,
	sweepExpiredPartClaims,
	sweepStaleCompletingSessions,
	sweepUntrackedMultipartUploads,
	sweepVerifyingSessions,
} from './session-maintenance.service.js';
import type {
	GameUploadPartSigningDependencies,
	GameUploadServiceDependencies,
} from './ports.js';

/** Isolate UploadPart signing from every multipart mutation and byte port. */
export function createGameUploadPartSigningDependencies(
	deps: GameUploadServiceDependencies,
): GameUploadPartSigningDependencies {
	return {
		repository: {
			findSessionById: (id) => deps.repository.findSessionById(id),
			isSessionActive: (sessionId) => deps.repository.isSessionActive(sessionId),
		},
		partSigner: {
			presignUploadPart: (key, uploadId, partNumber, expiresInSeconds) => (
				deps.partSigner.presignUploadPart(key, uploadId, partNumber, expiresInSeconds)
			),
		},
		clock: { now: () => deps.clock.now() },
		authorizeProjectWrite: (actor, projectId) => (
			deps.authorizeProjectWrite(actor, projectId)
		),
		config: {
			uploadPartUrlBatchMax: deps.config.uploadPartUrlBatchMax,
			uploadPartUrlTtlSeconds: deps.config.uploadPartUrlTtlSeconds,
		},
		logger: {
			info: deps.logger.info
				? (context, message) => deps.logger.info?.(context, message)
				: undefined,
		},
	};
}

/** Build the application use-cases from explicit ports. */
export function createGameUploadService(deps: GameUploadServiceDependencies) {
	const partSigningDeps = createGameUploadPartSigningDependencies(deps);
	return {
		createSession: (...args: Parameters<typeof createSession> extends [unknown, ...infer Rest] ? Rest : never) => (
			createSession(deps, ...args)
		),
		uploadChunk: (...args: Parameters<typeof uploadChunk> extends [unknown, ...infer Rest] ? Rest : never) => (
			uploadChunk(deps, ...args)
		),
		authorizeLegacyChunkUpload: (...args: Parameters<typeof authorizeLegacyChunkUpload> extends [unknown, ...infer Rest] ? Rest : never) => (
			authorizeLegacyChunkUpload(deps, ...args)
		),
		signPartUrls: (...args: Parameters<typeof signPartUrls> extends [unknown, ...infer Rest] ? Rest : never) => (
			signPartUrls(partSigningDeps, ...args)
		),
		completeSession: (...args: Parameters<typeof completeSession> extends [unknown, ...infer Rest] ? Rest : never) => (
			completeSession(deps, ...args)
		),
		cancelSession: (...args: Parameters<typeof cancelSession> extends [unknown, ...infer Rest] ? Rest : never) => (
			cancelSession(deps, ...args)
		),
		getSessionStatus: (...args: Parameters<typeof getSessionStatus> extends [unknown, ...infer Rest] ? Rest : never) => (
			getSessionStatus(deps, ...args)
		),
		listSessions: (...args: Parameters<typeof listSessions> extends [unknown, ...infer Rest] ? Rest : never) => (
			listSessions(deps, ...args)
		),
		sweepStaleCompletingSessions: (signal?: AbortSignal) => (
			sweepStaleCompletingSessions(deps, signal)
		),
		sweepVerifyingSessions: (signal?: AbortSignal) => (
			sweepVerifyingSessions(deps, signal)
		),
		sweepExpiredPendingSessions: (signal?: AbortSignal) => (
			sweepExpiredPendingSessions(deps, signal)
		),
		sweepExpiredPartClaims: (signal?: AbortSignal) => sweepExpiredPartClaims(deps, signal),
		sweepUntrackedMultipartUploads: (signal?: AbortSignal) => (
			sweepUntrackedMultipartUploads(deps, signal)
		),
	};
}
