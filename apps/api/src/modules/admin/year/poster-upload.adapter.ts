import { createWriteStream, promises as fs } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { PosterUploadCoordinator } from '../../../application/upload-ports.js';
import { badRequest, payloadTooLarge } from '../../../shared/errors.js';
import { SIZE_LIMITS } from '../../../shared/file-signature.js';
import { assertValidUploadFilename } from '../../../shared/filename-validation.js';
import { createByteLimiter, kindLimit } from '../../../shared/upload-limits.js';
import { UploadPipeline } from '../../assets/upload/index.js';

export const exhibitionPosterUploadCoordinator: PosterUploadCoordinator = {
	async start(parts, limits) {
		const pipeline = new UploadPipeline();
		try {
			let tmpPath: string | null = null;
			let originalName = '';
			let fileCount = 0;

			for await (const part of parts) {
				if (part.type !== 'file') continue;
				if (part.fieldname !== 'poster') throw badRequest('Multipart field must be poster');
				fileCount++;
				if (fileCount > 1) throw badRequest('Only one poster file is allowed');
				assertValidUploadFilename(part.filename);

				const nextPath = path.join(os.tmpdir(), crypto.randomUUID());
				pipeline.trackTempFile(nextPath);
				const maxBytes = Math.max(kindLimit(limits, 'POSTER'), SIZE_LIMITS.posterPdf);
				await streamPipeline(
					part.file,
					createByteLimiter(maxBytes, part.filename),
					createWriteStream(nextPath),
				);
				tmpPath = nextPath;
				originalName = part.filename;
			}

			if (!tmpPath) throw badRequest('No poster file provided');
			const stat = await fs.stat(tmpPath);
			if (stat.size > limits.requestMaxBytes) {
				const limitMB = Math.round(limits.requestMaxBytes / 1024 / 1024);
				throw payloadTooLarge(`Total upload size exceeds ${limitMB}MB limit`);
			}

			const savedFile = await pipeline.processFile(tmpPath, 'POSTER', originalName);
			return {
				savedFile,
				rollback: () => pipeline.rollbackCommitted(),
				cleanup: () => pipeline.cleanupTemp(),
			};
		} catch (error) {
			await pipeline.rollbackCommitted();
			await pipeline.cleanupTemp();
			throw error;
		}
	},
};
