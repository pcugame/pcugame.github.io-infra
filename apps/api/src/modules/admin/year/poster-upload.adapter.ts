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
	uploadIntents?: {
		prepare(input: {
			bucket: string;
			storageKey: string;
			purpose: string;
			ownerOperationId?: string;
			ownerActorId?: number;
			ownerProjectId?: number;
			ownerExhibitionId?: number;
		}): Promise<string>;
		markUploaded(id: string): Promise<void>;
		isUncommitted(id: string): Promise<boolean>;
		recordAmbiguousError(id: string, error: unknown): Promise<void>;
	};
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
		async start(parts, limits, owner = {}) {
			const temporaryPaths = new Set<string>();
			let committedKey: string | null = null;
			let intentId: string | undefined;

			async function cleanupTemporaryFiles(): Promise<void> {
				const failures: unknown[] = [];
				for (const temporaryPath of [...temporaryPaths]) {
					try {
						await deps.fileSystem.remove(temporaryPath);
						temporaryPaths.delete(temporaryPath);
					} catch (error) {
						failures.push(error);
						deps.logger.warn(
							{ error, temporaryPath },
							'Exhibition poster temp-file cleanup failed',
						);
					}
				}
				if (failures.length > 0) {
					throw new AggregateError(
						failures,
						'Exhibition poster temp-file cleanup failed',
					);
				}
			}

			async function rollbackCommitted(): Promise<void> {
				if (!committedKey) return;
				if (intentId && deps.uploadIntents
					&& !(await deps.uploadIntents.isUncommitted(intentId))) {
					committedKey = null;
					return;
				}
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
				intentId = await deps.uploadIntents?.prepare({
					bucket: deps.bucket,
					storageKey: key,
					purpose: 'exhibition-poster',
					...(owner.operationId ? { ownerOperationId: owner.operationId } : {}),
					...(owner.actorId !== undefined ? { ownerActorId: owner.actorId } : {}),
					...(owner.projectId !== undefined ? { ownerProjectId: owner.projectId } : {}),
					...(owner.exhibitionId !== undefined
						? { ownerExhibitionId: owner.exhibitionId }
						: {}),
				});
				try {
					await deps.storage.upload(
						deps.bucket,
						key,
						deps.fileSystem.createReadStream(processed.tmpPath),
						processed.mimeType,
						finalStat.size,
						storageOptionsForAsset('POSTER'),
					);
				} catch (error) {
					if (intentId) await deps.uploadIntents?.recordAmbiguousError(intentId, error).catch(
						(intentError) => deps.logger.error(
							{ error: intentError, intentId, storageKey: key },
							'Failed to annotate ambiguous poster upload intent',
						),
					);
					throw error;
				}
				if (intentId) await deps.uploadIntents?.markUploaded(intentId);

				return {
					savedFile: {
						storageKey: key,
						mimeType: processed.mimeType,
						sizeBytes: processed.sizeBytes,
						originalName,
						kind: 'POSTER',
						uploadIntentIds: intentId ? [intentId] : [],
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
				let tempError: unknown;
				try {
					await cleanupTemporaryFiles();
				} catch (cleanupError) {
					tempError = cleanupError;
				}
				if (rollbackError !== undefined || tempError !== undefined) {
					throw new AggregateError(
						[error, rollbackError, tempError].filter(
							(value) => value !== undefined,
						),
						'Exhibition poster upload or cleanup failed',
					);
				}
				throw error;
			}
		},
	};
}
