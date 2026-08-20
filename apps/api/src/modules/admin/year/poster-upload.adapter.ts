import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import type {
	AppLogger,
	FileSystem,
	IdGenerator,
	ObjectStorage,
} from '../../../application/ports.js';
import type {
	ActiveUploadTempRegistry,
	PosterUploadCoordinator,
} from '../../../application/upload-ports.js';
import { badRequest, payloadTooLarge } from '../../../shared/errors.js';
import { assertValidUploadFilename } from '../../../shared/filename-validation.js';
import { processImage } from '../../assets/upload/image-processing.js';
import { processPdf } from '../../assets/upload/pdf-processing.js';
import {
	createProjectUploadPipeline,
	type ProjectUploadProcessing,
} from '../project/project-upload.adapter.js';
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
	activeUploadTemps?: ActiveUploadTempRegistry;
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

function createPosterProcessing(
	deps: Pick<ExhibitionPosterUploadDependencies, 'fileSystem' | 'logger'>,
): ProjectUploadProcessing {
	return {
		async validate(filePath, kind) {
			if (kind !== 'POSTER') throw new Error('Exhibition upload only accepts POSTER');
			const stat = await deps.fileSystem.stat(filePath);
			return validatePosterFile({
				sizeBytes: stat.size,
				header: await readHeader(deps.fileSystem, filePath),
			});
		},
		processImage: (input) => processImage(input, deps.fileSystem),
		processPdf: (input) => processPdf(input, deps.logger, deps.fileSystem),
	};
}

/**
 * Collect the exhibition-specific multipart shape, then delegate processing,
 * immutable key creation, intent tracking, PUTs, rollback, and temp ownership
 * to the same upload pipeline used by project images.
 */
export function createExhibitionPosterUploadCoordinator(
	deps: ExhibitionPosterUploadDependencies,
): PosterUploadCoordinator {
	return {
		async start(parts, limits, owner = {}) {
			const uploadPipeline = createProjectUploadPipeline({
				storage: deps.storage,
				fileSystem: deps.fileSystem,
				ids: deps.ids,
				logger: deps.logger,
				processing: createPosterProcessing(deps),
				purposePrefix: 'exhibition',
				bucketForKind: () => deps.bucket,
				deleteUnpersistedObject: async (_bucket, key) => {
					try {
						await deps.deleteUnpersistedObject(key);
					} catch (error) {
						throw new AggregateError(
							[error],
							'Object deletion and durable orphan recording both failed',
						);
					}
				},
				...(deps.uploadIntents ? { uploadIntents: deps.uploadIntents } : {}),
				...(deps.activeUploadTemps ? { activeUploadTemps: deps.activeUploadTemps } : {}),
			});
			uploadPipeline.setOwner?.(owner);

			try {
				let temporaryPath: string | null = null;
				let originalName = '';
				let hasPoster = false;

				for await (const part of parts) {
					if (part.type !== 'file') {
						throw badRequest('Multipart body must contain exactly one poster file');
					}
					if (hasPoster || part.fieldname !== 'poster') {
						// Busboy pauses the multipart parser on an unconsumed file. Drain an
						// invalid or trailing file before rejecting so the request cannot hang.
						part.file.resume();
						throw badRequest(
							hasPoster
								? 'Only one poster file is allowed'
								: 'Multipart field must be poster',
						);
					}
					hasPoster = true;
					assertValidUploadFilename(part.filename);

					const nextPath = path.join(
						deps.fileSystem.temporaryDirectory(),
						`exhibition-poster-${deps.ids.next()}`,
					);
					uploadPipeline.trackTempFile(nextPath);
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

				const savedFile = await uploadPipeline.processFile(
					temporaryPath,
					'POSTER',
					originalName,
				);
				return {
					savedFile,
					rollback: () => uploadPipeline.rollbackCommitted(),
					cleanup: () => uploadPipeline.cleanupTemp(),
				};
			} catch (error) {
				let rollbackError: unknown;
				try {
					await uploadPipeline.rollbackCommitted();
				} catch (cleanupError) {
					rollbackError = cleanupError;
				}
				let tempError: unknown;
				try {
					await uploadPipeline.cleanupTemp();
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
