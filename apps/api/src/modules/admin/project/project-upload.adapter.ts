import type { InlineAssetKind } from '@pcu/contracts';
import type {
	AppLogger,
	FileSystem,
	IdGenerator,
	ObjectStorage,
} from '../../../application/ports.js';
import type {
	ActiveUploadTempRegistry,
	ImageRenditionProfile,
	SavedUpload,
	UploadIntentOwner,
	UploadPipelinePort,
} from '../../../application/upload-ports.js';
import { deriveImageRenditionStorageKey } from '../../../shared/responsive-image.js';
import { generateStorageKey } from '../../../shared/storage-path.js';
import type {
	ImageProcessingInput,
	ImageProcessingResult,
} from '../../assets/upload/image-processing.js';
import { ImageOutputCleanupError } from '../../assets/upload/image-processing.js';
import type { PdfProcessingInput } from '../../assets/upload/pdf-processing.js';
import { createIntentTrackedObjectUploader } from '../../assets/upload/intent-tracked-object-upload.js';
import { storageOptionsForAsset } from '../../assets/upload/storage-policy.js';

export interface ProjectUploadProcessing {
	validate(
		filePath: string,
		kind: InlineAssetKind,
	): Promise<{ mimeType: string; ext: string; sizeBytes: number }>;
	processImage(input: ImageProcessingInput): Promise<ImageProcessingResult>;
	processPdf(input: PdfProcessingInput): Promise<ImageProcessingResult>;
}

export interface ProjectUploadPipelineDependencies {
	storage: ObjectStorage;
	fileSystem: FileSystem;
	ids: IdGenerator;
	logger: AppLogger;
	processing: ProjectUploadProcessing;
	purposePrefix?: 'project' | 'exhibition';
	bucketForKind(kind: InlineAssetKind): string;
	deleteUnpersistedObject(
		bucket: string,
		key: string,
		reason: string,
		context?: Record<string, unknown>,
	): Promise<void>;
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
	/** Context-local guard preventing the scavenger from racing active requests. */
	activeUploadTemps?: Pick<ActiveUploadTempRegistry, 'register' | 'release'>;
}

type UploadPurpose = 'original' | 'playback' | 'rendition-card-480' | 'rendition-display-960';

function renditionPurpose(
	profile: ImageRenditionProfile,
): 'rendition-card-480' | 'rendition-display-960' {
	return profile === 'CARD_480' ? 'rendition-card-480' : 'rendition-display-960';
}

const TEMP_CLEANUP_MAX_ATTEMPTS = 3;

function isMissingFile(error: unknown): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& error.code === 'ENOENT';
}

export class ProjectTempCleanupError extends AggregateError {
	readonly residuePaths: readonly string[];
	readonly maxAttempts: number;

	constructor(errors: unknown[], residuePaths: readonly string[]) {
		super(errors, 'Project upload temp-file cleanup failed');
		this.name = 'ProjectTempCleanupError';
		this.residuePaths = residuePaths;
		this.maxAttempts = TEMP_CLEANUP_MAX_ATTEMPTS;
	}
}

/**
 * A request-owned pipeline whose external resources all come from one
 * BackendContext. Object cleanup intent is recorded before each PUT so an
 * object store that persists and then reports a transport error cannot leak an
 * unreferenced object outside ticket-003's durable deletion contract.
 */
export function createProjectUploadPipeline(
	deps: ProjectUploadPipelineDependencies,
): UploadPipelinePort {
	const temporaryPaths = new Set<string>();
	function trackTemporaryPath(temporaryPath: string): void {
		if (temporaryPaths.has(temporaryPath)) return;
		temporaryPaths.add(temporaryPath);
		deps.activeUploadTemps?.register(temporaryPath);
	}
	let owner: UploadIntentOwner = {};
	const objectUploads = createIntentTrackedObjectUploader({
		storage: deps.storage,
		uploadIntents: deps.uploadIntents,
		deleteUnpersistedObject: ({ bucket, storageKey, reason, context }) => (
			deps.deleteUnpersistedObject(bucket, storageKey, reason, context)
		),
		logger: deps.logger,
		uploadStreamFailureMessage: 'Project object upload and request-stream cleanup failed',
		rollbackFailureMessage: 'Project upload durable rollback failed',
		ambiguousErrorLogMessage: 'Failed to annotate ambiguous upload intent',
	});

	async function upload(
		filePath: string,
		kind: InlineAssetKind,
		extension: string,
		contentType: string,
		purpose: UploadPurpose,
		storageRole?: 'original' | 'playback' | 'rendition',
		storageKey?: string,
	): Promise<{ key: string; intentId?: string }> {
		const bucket = deps.bucketForKind(kind);
		const key = storageKey ?? generateStorageKey(extension, deps.ids.next());
		const objectRole: 'original' | 'playback' | 'rendition' = storageRole ?? (
			purpose === 'original' || purpose === 'playback' ? purpose : 'rendition'
		);
		const stat = await deps.fileSystem.stat(filePath);
		const uploaded = await objectUploads.upload({
			bucket,
			storageKey: key,
			purpose: `${deps.purposePrefix ?? 'project'}-${kind.toLowerCase()}-${purpose}`,
			owner,
			createBody: () => deps.fileSystem.createReadStream(filePath),
			contentType,
			contentLength: stat.size,
			storageOptions: storageOptionsForAsset(kind, objectRole),
			rollbackReason: `project-upload-unpersisted-${purpose}`,
			rollbackContext: { kind },
			logContext: { kind, purpose },
		});
		return { key, ...uploaded };
	}

	return {
		setOwner(nextOwner) {
			owner = { ...nextOwner };
		},
		trackTempFile(filePath) {
			trackTemporaryPath(filePath);
		},

		async processFile(filePath, kind: InlineAssetKind, originalName): Promise<SavedUpload> {
			const validated = await deps.processing.validate(filePath, kind);

			const createRenditions = kind !== 'THUMBNAIL';
			let processed: ImageProcessingResult;
			try {
				processed = validated.mimeType === 'application/pdf'
					? await deps.processing.processPdf({
						tmpPath: filePath,
						createRenditions,
					})
					: await deps.processing.processImage({
						tmpPath: filePath,
						mimeType: validated.mimeType,
						ext: validated.ext,
						sizeBytes: validated.sizeBytes,
						createRenditions,
					});
			} catch (error) {
				if (error instanceof ImageOutputCleanupError) {
					for (const residuePath of error.residuePaths) {
						trackTemporaryPath(residuePath);
					}
				}
				throw error;
			}
			for (const output of [processed.original, ...processed.renditions]) {
				if (output.tmpPath !== filePath) trackTemporaryPath(output.tmpPath);
			}

			const originalUpload = await upload(
				processed.original.tmpPath,
				kind,
				processed.original.ext,
				processed.original.mimeType,
				'original',
			);
			const uploadedRenditions = [] as Array<{
				profile: ImageRenditionProfile;
				key: string;
				intentId?: string;
				processed: ImageProcessingResult['renditions'][number];
			}>;
			for (const rendition of processed.renditions) {
				const renditionStorageKey = deriveImageRenditionStorageKey(
					originalUpload.key,
					rendition.profile,
				);
				const renditionUpload = await upload(
					rendition.tmpPath,
					kind,
					rendition.ext,
					rendition.mimeType,
					renditionPurpose(rendition.profile),
					'rendition',
					renditionStorageKey,
				);
				uploadedRenditions.push({
					profile: rendition.profile,
					key: renditionUpload.key,
					...(renditionUpload.intentId
						? { intentId: renditionUpload.intentId }
						: {}),
					processed: rendition,
				});
			}

			return {
				storageKey: originalUpload.key,
				mimeType: processed.original.mimeType,
				sizeBytes: processed.original.sizeBytes,
				originalName,
				kind,
				width: processed.original.width,
				height: processed.original.height,
				renditions: uploadedRenditions.map((rendition) => ({
					profile: rendition.profile,
					width: rendition.processed.width,
					height: rendition.processed.height,
				})),
				uploadIntentIds: [
					originalUpload.intentId,
					...uploadedRenditions.map((rendition) => rendition.intentId),
				].filter((id): id is string => typeof id === 'string'),
			};
		},

		async rollbackCommitted() {
			await objectUploads.rollback();
		},

		async cleanupTemp() {
			const failures: unknown[] = [];
			const trackedPaths = [...temporaryPaths];
			try {
				for (const temporaryPath of trackedPaths) {
					let removed = false;
					for (let attempt = 1; attempt <= TEMP_CLEANUP_MAX_ATTEMPTS; attempt++) {
						try {
							await deps.fileSystem.remove(temporaryPath);
							removed = true;
							break;
						} catch (error) {
							if (isMissingFile(error)) {
								removed = true;
								break;
							}
							deps.logger.warn(
								{
									error,
									temporaryPath,
									attempt,
									maxAttempts: TEMP_CLEANUP_MAX_ATTEMPTS,
								},
								'Project upload temp-file cleanup attempt failed',
							);
							if (attempt === TEMP_CLEANUP_MAX_ATTEMPTS) {
								failures.push(error);
							}
						}
					}
					if (removed) temporaryPaths.delete(temporaryPath);
				}
				if (failures.length > 0) {
					const residuePaths = [...temporaryPaths];
					deps.logger.error(
						{
							residuePaths,
							maxAttempts: TEMP_CLEANUP_MAX_ATTEMPTS,
						},
						'Project upload temp-file cleanup exhausted retries',
					);
					throw new ProjectTempCleanupError(failures, residuePaths);
				}
			} finally {
				// The request lifetime has ended even when removal exhausted retries.
				for (const temporaryPath of trackedPaths) {
					deps.activeUploadTemps?.release(temporaryPath);
				}
			}
		},
	};
}
