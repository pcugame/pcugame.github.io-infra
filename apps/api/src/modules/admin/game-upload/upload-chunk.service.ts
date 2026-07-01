import type { GameUploadChunkResponse } from '@pcu/contracts';
import { env } from '../../../config/env.js';
import { uploadPart } from '../../../lib/storage.js';
import { AppError, badRequest } from '../../../shared/errors.js';
import { acquireUploadSlot, releaseUploadSlot } from '../../../shared/upload-limits.js';
import { createCountedChunkStream } from './chunk-stream.js';
import { loadSession } from './session-loader.js';
import { assertGameUploadSessionWritable } from './session-policy.js';
import * as repo from './repository.js';

/** Upload one chunk as an S3 multipart part */
export async function uploadChunk(
	sessionId: string,
	chunkIndex: number,
	body: NodeJS.ReadableStream,
	user: { id: number; role: string },
): Promise<GameUploadChunkResponse> {
	acquireUploadSlot();
	try {
		const session = await loadSession(sessionId, user.id, user.role);

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

		const cfg = env();
		const partNumber = chunkIndex + 1;
		const countedBody = createCountedChunkStream(body, chunkIndex, expectedSize);

		let etag: string;
		try {
			etag = await uploadPart(
				cfg.S3_BUCKET_PROTECTED,
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

		await repo.appendPartEtag(session.id, partNumber, etag);
		const updated = await repo.appendChunkIndex(session.id, chunkIndex);
		const newChunks = updated[0]?.uploaded_chunks ?? [];

		return {
			index: chunkIndex,
			bytesWritten,
			uploadedCount: newChunks.length,
			totalChunks: session.totalChunks,
		};
	} finally {
		releaseUploadSlot();
	}
}
