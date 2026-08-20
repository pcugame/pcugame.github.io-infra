import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type { InlineAssetKind } from '@pcu/contracts';
import type {
	FileSystem,
	IdGenerator,
} from '../../../application/ports.js';
import type {
	SingleAssetUploadCoordinator,
	MultipartRequestHasher,
	UploadPipelinePort,
} from '../../../application/upload-ports.js';
import { badRequest, payloadTooLarge } from '../../../shared/errors.js';
import {
	createKindAwareByteLimiter,
	kindLimitForMime,
} from '../../../shared/upload-policy.js';
import { detectFileType } from '../../../shared/file-signature.js';
import { assertValidUploadFilename } from '../../../shared/filename-validation.js';
import { InlineAssetKindEnum } from '../../../shared/validation.js';

export interface ProjectAssetUploadDependencies {
	fileSystem: FileSystem;
	ids: IdGenerator;
	createPipeline(): UploadPipelinePort;
	requestHasher?: MultipartRequestHasher;
}

/**
 * Single-asset multipart coordinator. It owns parser stream consumption and
 * the request pipeline owns all temp/object cleanup.
 */
export function createProjectAssetUploadCoordinator(
	deps: ProjectAssetUploadDependencies,
): SingleAssetUploadCoordinator {
	return {
		async start(parts, limits, owner, beforeUpload) {
			const pipeline = deps.createPipeline();
			if (owner) pipeline.setOwner?.(owner);
			try {
				let kind: InlineAssetKind | null = null;
				let fileTmpPath: string | null = null;
				let fileOriginalName = '';
				let grammarState: 'kind' | 'file' | 'done' = 'kind';

				for await (const part of parts) {
					if (grammarState === 'kind') {
						if (part.type !== 'field' || part.fieldname !== 'kind') {
							if (part.type === 'file') part.file.resume();
							throw badRequest('Inline asset multipart must begin with exactly one kind field');
						}
						const parsed = InlineAssetKindEnum.safeParse(part.value);
						if (!parsed.success) throw badRequest(`Invalid asset kind: ${part.value}`);
						kind = parsed.data;
						grammarState = 'file';
						continue;
					}

					if (grammarState === 'file') {
						if (!kind) throw new Error('Inline multipart grammar lost its validated kind');
						if (part.type !== 'file' || part.fieldname !== 'file') {
							if (part.type === 'file') part.file.resume();
							throw badRequest('Inline asset multipart requires exactly one file after kind');
						}
						assertValidUploadFilename(part.filename);
						const tmpPath = path.join(
							deps.fileSystem.temporaryDirectory(),
							`project-asset-${deps.ids.next()}`,
						);
						pipeline.trackTempFile(tmpPath);
						await streamPipeline(
							part.file,
							createKindAwareByteLimiter(limits, kind, part.filename),
							deps.fileSystem.createWriteStream(tmpPath),
						);
						fileTmpPath = tmpPath;
						fileOriginalName = part.filename;
						grammarState = 'done';
						continue;
					}

					if (part.type === 'file') part.file.resume();
					throw badRequest('Inline asset multipart contains trailing or duplicate parts');
				}

				if (grammarState === 'kind' || !kind) throw badRequest('Missing asset kind');
				if (grammarState !== 'done' || !fileTmpPath) throw badRequest('No file provided');

				const header = await deps.fileSystem.readRange(fileTmpPath, 0, 15);
				const exactLimit = kindLimitForMime(
					limits,
					kind,
					detectFileType(header)?.mime,
				);
				const fileStat = await deps.fileSystem.stat(fileTmpPath);
				if (fileStat.size > exactLimit) {
					const limitMB = Math.round(exactLimit / 1024 / 1024);
					throw payloadTooLarge(
						`File exceeds ${kind} size limit of ${limitMB}MB`,
					);
				}
				if (fileStat.size > limits.requestMaxBytes) {
					const limitMB = Math.round(limits.requestMaxBytes / 1024 / 1024);
					throw payloadTooLarge(
						`Total upload size exceeds ${limitMB}MB limit`,
					);
				}

				const hashFiles = [{
						tmpPath: fileTmpPath,
						fieldname: 'file',
						filename: fileOriginalName,
					}];
				const requestHash = deps.requestHasher
					? await deps.requestHasher.hash({ kind }, hashFiles)
					: '';
				if (beforeUpload) {
					pipeline.setOwner?.(await beforeUpload(requestHash));
				}
				const savedFile = await pipeline.processFile(
					fileTmpPath,
					kind,
					fileOriginalName,
				);
				return {
					savedFile,
					requestHash,
					rollback: () => pipeline.rollbackCommitted(),
					cleanup: () => pipeline.cleanupTemp(),
				};
			} catch (error) {
				let rollbackFailure: unknown;
				try {
					await pipeline.rollbackCommitted();
				} catch (cleanupError) {
					rollbackFailure = cleanupError;
				}
				let tempFailure: unknown;
				try {
					await pipeline.cleanupTemp();
				} catch (cleanupError) {
					tempFailure = cleanupError;
				}
				if (rollbackFailure !== undefined || tempFailure !== undefined) {
					throw new AggregateError(
						[error, rollbackFailure, tempFailure].filter(
							(value) => value !== undefined,
						),
						'Project asset upload and cleanup failed',
					);
				}
				throw error;
			}
		},
	};
}
