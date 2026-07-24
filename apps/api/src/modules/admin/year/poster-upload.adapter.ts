import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type {
	AppLogger,
	FileSystem,
	IdGenerator,
	ObjectStorage,
} from '../../../application/ports.js';
import type { PosterUploadCoordinator } from '../../../application/upload-ports.js';
import { badRequest, payloadTooLarge } from '../../../shared/errors.js';
import { assertValidUploadFilename } from '../../../shared/filename-validation.js';
import { processImage } from '../../assets/upload/image-processing.js';
import { processPdf } from '../../assets/upload/pdf-processing.js';
import { storageOptionsForAsset } from '../../assets/upload/storage-policy.js';
import { validatePosterFile } from './poster-file-validation.js';
import { createPosterByteLimiter } from './poster-upload.policy.js';

export interface ExhibitionPosterUploadDependencies {
	bucket: string;
	storage: ObjectStorage;
	fileSystem: FileSystem;
	ids: IdGenerator;
	logger: AppLogger;
	deleteUnpersistedObject(storageKey: string): Promise<void>;
}

function storageKey(id: string, extension: string): string {
	const safeExtension = extension.replace(/[^a-zA-Z0-9]/g, '');
	return `${id}.${safeExtension}`;
}

async function readHeader(
	fileSystem: FileSystem,
	filePath: string,
	bytes = 16,
): Promise<Buffer> {
	const stream = fileSystem.createReadStream(filePath);
	const chunks: Buffer[] = [];
	let collected = 0;
	try {
		for await (const chunk of stream) {
			const buffer = Buffer.from(chunk);
			const remaining = bytes - collected;
			chunks.push(buffer.subarray(0, remaining));
			collected += Math.min(buffer.length, remaining);
			if (collected >= bytes) break;
		}
	} finally {
		stream.destroy();
	}
	return Buffer.concat(chunks, collected);
}

/**
 * Context-owned poster upload adapter. Temp-file and object upload work happens
 * before the repository transaction. `rollback` guarantees that an unpersisted
 * object is either deleted or represented by ticket-003's durable orphan row.
 * Cleanup intent is registered before upload because an object store can persist
 * a PUT and still report an ambiguous transport failure. ObjectStorage.delete
 * is therefore required to treat a missing key as an idempotent success.
 */
export function createExhibitionPosterUploadCoordinator(
	deps: ExhibitionPosterUploadDependencies,
): PosterUploadCoordinator {
	return {
		async start(parts, limits) {
			const temporaryPaths = new Set<string>();
			let committedKey: string | null = null;

			async function cleanupTemporaryFiles(): Promise<void> {
				for (const temporaryPath of temporaryPaths) {
					await deps.fileSystem.remove(temporaryPath).catch((error) => {
						deps.logger.warn(
							{ error, temporaryPath },
							'Exhibition poster temp-file cleanup failed',
						);
					});
				}
				temporaryPaths.clear();
			}

			async function rollbackCommitted(): Promise<void> {
				if (!committedKey) return;
				const key = committedKey;
				await deps.deleteUnpersistedObject(key);
				committedKey = null;
			}

			try {
				let temporaryPath: string | null = null;
				let originalName = '';
				let fileCount = 0;

				for await (const part of parts) {
					if (part.type !== 'file') continue;
					if (part.fieldname !== 'poster') throw badRequest('Multipart field must be poster');
					fileCount += 1;
					if (fileCount > 1) throw badRequest('Only one poster file is allowed');
					assertValidUploadFilename(part.filename);

					const nextPath = path.join(
						deps.fileSystem.temporaryDirectory(),
						`exhibition-poster-${deps.ids.next()}`,
					);
					temporaryPaths.add(nextPath);
					await streamPipeline(
						part.file,
						createPosterByteLimiter(limits, part.filename),
						deps.fileSystem.createWriteStream(nextPath),
					);
					temporaryPath = nextPath;
					originalName = part.filename;
				}

				if (!temporaryPath) throw badRequest('No poster file provided');
				const sourceStat = await deps.fileSystem.stat(temporaryPath);
				if (sourceStat.size > limits.requestMaxBytes) {
					const limitMB = Math.round(limits.requestMaxBytes / 1024 / 1024);
					throw payloadTooLarge(`Total upload size exceeds ${limitMB}MB limit`);
				}

				const validated = validatePosterFile({
					sizeBytes: sourceStat.size,
					header: await readHeader(deps.fileSystem, temporaryPath),
				});
				const processed = validated.mimeType === 'application/pdf'
					? await processPdf(
						{ tmpPath: temporaryPath },
						deps.logger,
						deps.fileSystem,
					)
					: await processImage({
						tmpPath: temporaryPath,
						mimeType: validated.mimeType,
						ext: validated.ext,
						sizeBytes: validated.sizeBytes,
					}, deps.fileSystem);
				if (processed.tmpPath !== temporaryPath) temporaryPaths.add(processed.tmpPath);

				const finalStat = await deps.fileSystem.stat(processed.tmpPath);
				const key = storageKey(deps.ids.next(), processed.ext);
				committedKey = key;
				await deps.storage.upload(
					deps.bucket,
					key,
					deps.fileSystem.createReadStream(processed.tmpPath),
					processed.mimeType,
					finalStat.size,
					storageOptionsForAsset('POSTER'),
				);

				return {
					savedFile: {
						storageKey: key,
						mimeType: processed.mimeType,
						sizeBytes: processed.sizeBytes,
						originalName,
						kind: 'POSTER',
					},
					rollback: rollbackCommitted,
					cleanup: cleanupTemporaryFiles,
				};
			} catch (error) {
				let rollbackError: unknown;
				try {
					await rollbackCommitted();
				} catch (cleanupError) {
					rollbackError = cleanupError;
				}
				await cleanupTemporaryFiles();
				if (rollbackError !== undefined) {
					throw new AggregateError(
						[error, rollbackError],
						'Exhibition poster upload and durable rollback both failed',
					);
				}
				throw error;
			}
		},
	};
}
