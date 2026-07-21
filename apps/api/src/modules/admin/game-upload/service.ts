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
import { uploadChunk } from './upload-chunk.service.js';
import { completeSession } from './complete-session.service.js';
import {
	cancelSession,
	getSessionStatus,
	listSessions,
	sweepStaleCompletingSessions,
} from './session-maintenance.service.js';
import type { GameUploadServiceDependencies } from './ports.js';

/** Build the application use-cases from explicit ports. */
export function createGameUploadService(deps: GameUploadServiceDependencies) {
	return {
		createSession: (...args: Parameters<typeof createSession> extends [unknown, ...infer Rest] ? Rest : never) => (
			createSession(deps, ...args)
		),
		uploadChunk: (...args: Parameters<typeof uploadChunk> extends [unknown, ...infer Rest] ? Rest : never) => (
			uploadChunk(deps, ...args)
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
		sweepStaleCompletingSessions: () => sweepStaleCompletingSessions(deps),
	};
}
