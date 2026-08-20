/**
 * Resumable direct game-file upload control plane (S3 multipart).
 *
 * Flow:
 *   1. createSession()    -> create S3 multipart upload + DB session
 *   2. signPartUrls()     -> issue short-lived UploadPart capabilities
 *   3. getSessionStatus() -> reconcile progress from Garage ListParts
 *   4. completeSession()  -> complete multipart upload -> verification queue
 *   5. cancelSession()    -> abort multipart upload + cleanup
 */

export { assertGameUploadSessionWritable } from './session-policy.js';
export { resolveChunkSizeBytes } from './session-sizing.js';

import { createSession } from './create-session.service.js';
import { completeSession } from './complete-session.service.js';
import { signPartUrls } from './sign-part-urls.service.js';
import {
	cancelSession,
	getSessionStatus,
	listSessions,
	sweepExpiredPendingSessions,
	sweepStaleCompletingSessions,
	sweepUntrackedMultipartUploads,
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
			reservePartCapabilities: (input) => deps.repository.reservePartCapabilities(input),
		},
		partSigner: {
			presignUploadPart: (key, uploadId, partNumber, expiresInSeconds, checksumSha256) => (
				deps.partSigner.presignUploadPart(
					key, uploadId, partNumber, expiresInSeconds, checksumSha256,
				)
			),
		},
		clock: { now: () => deps.clock.now() },
		config: {
			uploadPartUrlBatchMax: deps.config.uploadPartUrlBatchMax,
			uploadPartUrlTtlSeconds: deps.config.uploadPartUrlTtlSeconds,
			uploadPartUrlRefreshMax: deps.config.uploadPartUrlRefreshMax,
			uploadPartUrlRefreshWindowMs: deps.config.uploadPartUrlRefreshWindowMs,
			directUploadQuota: deps.config.directUploadQuota,
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
		sweepExpiredPendingSessions: (signal?: AbortSignal) => (
			sweepExpiredPendingSessions(deps, signal)
		),
		sweepUntrackedMultipartUploads: (signal?: AbortSignal) => (
			sweepUntrackedMultipartUploads(deps, signal)
		),
	};
}
