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

export { chunkUploadBodyLimitBytes, resolveChunkSizeBytes } from './session-sizing.js';
export { createCountedChunkStream, chunkByteLength, toError } from './chunk-stream.js';
export { loadSession } from './session-loader.js';
export { assertGameUploadSessionWritable } from './session-policy.js';
export { createSession } from './create-session.service.js';
export { uploadChunk } from './upload-chunk.service.js';
export { completeSession } from './complete-session.service.js';
export {
	cancelSession,
	getSessionStatus,
	listSessions,
	sweepStaleCompletingSessions,
} from './session-maintenance.service.js';
