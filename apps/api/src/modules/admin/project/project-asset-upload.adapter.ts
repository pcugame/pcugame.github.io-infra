import { createWriteStream, promises as fs } from 'node:fs';
import { pipeline as streamPipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type { AssetKind } from '@pcu/contracts';
import type { SingleAssetUploadCoordinator } from '../../../application/upload-ports.js';
import { badRequest, payloadTooLarge } from '../../../shared/errors.js';
import {
	createKindAwareByteLimiter,
	kindLimitForMime,
} from '../../../shared/upload-limits.js';
import { detectFileType } from '../../../shared/file-signature.js';
import { assertValidUploadFilename } from '../../../shared/filename-validation.js';
import { AssetKindEnum } from '../../../shared/validation.js';
import { UploadPipeline } from '../../assets/upload/index.js';

export const singleAssetUploadCoordinator: SingleAssetUploadCoordinator = {
	async start(parts, limits) {
		const pipeline = new UploadPipeline();
		try {
			let kind: AssetKind | null = null;
			let fileTmpPath: string | null = null;
			let fileOriginalName = '';

			for await (const part of parts) {
				if (part.type === 'field' && part.fieldname === 'kind') {
					const parsed = AssetKindEnum.safeParse(part.value);
					if (!parsed.success) throw badRequest(`Invalid asset kind: ${part.value}`);
					kind = parsed.data;
				} else if (part.type === 'file' && part.fieldname === 'file') {
					if (!kind) throw badRequest('Asset kind must be provided before file');
					assertValidUploadFilename(part.filename);
					const tmpPath = path.join(os.tmpdir(), crypto.randomUUID());
					pipeline.trackTempFile(tmpPath);
					await streamPipeline(
						part.file,
						createKindAwareByteLimiter(limits, kind, part.filename),
						createWriteStream(tmpPath),
					);
					fileTmpPath = tmpPath;
					fileOriginalName = part.filename;
				}
			}

			if (!kind) throw badRequest('Missing asset kind');
			if (!fileTmpPath) throw badRequest('No file provided');

			const header = Buffer.alloc(16);
			const handle = await fs.open(fileTmpPath, 'r');
			try {
				await handle.read(header, 0, 16, 0);
			} finally {
				await handle.close();
			}
			const exactLimit = kindLimitForMime(limits, kind, detectFileType(header)?.mime);
			const fileStat = await fs.stat(fileTmpPath);
			if (fileStat.size > exactLimit) {
				const limitMB = Math.round(exactLimit / 1024 / 1024);
				throw payloadTooLarge(`File exceeds ${kind} size limit of ${limitMB}MB`);
			}

			const savedFile = await pipeline.processFile(fileTmpPath, kind, fileOriginalName);
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
