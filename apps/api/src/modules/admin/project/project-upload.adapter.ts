import type { AssetKind } from '@pcu/contracts';
import type {
	AppLogger,
	FileSystem,
	IdGenerator,
	ObjectStorage,
} from '../../../application/ports.js';
import type {
	SavedUpload,
	UploadPipelinePort,
} from '../../../application/upload-ports.js';
import { badRequest } from '../../../shared/errors.js';
import { storageOptionsForAsset } from '../../assets/upload/storage-policy.js';

interface ProcessedImage {
	tmpPath: string;
	mimeType: string;
	ext: string;
	sizeBytes: number;
}

interface ProcessedVideo {
	playback: null | {
		tmpPath: string;
		mimeType: string;
		ext: string;
		sizeBytes: number;
	};
	playbackStatus: 'READY' | 'FAILED';
	playbackError: string;
}

export interface ProjectUploadProcessing {
	validate(
		filePath: string,
		kind: AssetKind,
	): Promise<{ mimeType: string; ext: string; sizeBytes: number }>;
	processImage(input: ProcessedImage): Promise<ProcessedImage>;
	processPdf(input: { tmpPath: string }): Promise<ProcessedImage>;
	processVideo(input: ProcessedImage): Promise<ProcessedVideo>;
}

export interface ProjectUploadPipelineDependencies {
	storage: ObjectStorage;
	fileSystem: FileSystem;
	ids: IdGenerator;
	logger: AppLogger;
	processing: ProjectUploadProcessing;
	bucketForKind(kind: AssetKind): string;
	deleteUnpersistedObject(
		bucket: string,
		key: string,
		reason: string,
		context?: Record<string, unknown>,
	): Promise<void>;
}

interface PendingObject {
	bucket: string;
	key: string;
	kind: AssetKind;
	purpose: 'original' | 'playback';
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

function storageKey(id: string, extension: string): string {
	return `${id}.${extension.replace(/[^a-zA-Z0-9]/g, '')}`;
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
	const pendingObjects: PendingObject[] = [];

	async function upload(
		filePath: string,
		kind: AssetKind,
		extension: string,
		contentType: string,
		purpose: PendingObject['purpose'],
	): Promise<string> {
		const bucket = deps.bucketForKind(kind);
		const key = storageKey(deps.ids.next(), extension);
		const stat = await deps.fileSystem.stat(filePath);
		pendingObjects.push({ bucket, key, kind, purpose });
		await deps.storage.upload(
			bucket,
			key,
			deps.fileSystem.createReadStream(filePath),
			contentType,
			stat.size,
			storageOptionsForAsset(kind, purpose),
		);
		return key;
	}

	return {
		trackTempFile(filePath) {
			temporaryPaths.add(filePath);
		},

		async processFile(filePath, kind, originalName): Promise<SavedUpload> {
			const validated = await deps.processing.validate(filePath, kind);

			if (kind === 'VIDEO') {
				const playback = await deps.processing.processVideo({
					tmpPath: filePath,
					mimeType: validated.mimeType,
					ext: validated.ext,
					sizeBytes: validated.sizeBytes,
				});
				if (playback.playbackStatus === 'FAILED') {
					throw badRequest(
						`Video validation failed: ${playback.playbackError || 'unsupported or corrupt video'}`,
					);
				}

				const originalKey = await upload(
					filePath,
					kind,
					validated.ext,
					validated.mimeType,
					'original',
				);
				let playbackStorageKey: string | null = null;
				let playbackMimeType = '';
				let playbackSizeBytes = 0;
				if (playback.playback) {
					temporaryPaths.add(playback.playback.tmpPath);
					playbackStorageKey = await upload(
						playback.playback.tmpPath,
						kind,
						playback.playback.ext,
						playback.playback.mimeType,
						'playback',
					);
					playbackMimeType = playback.playback.mimeType;
					playbackSizeBytes = playback.playback.sizeBytes;
				}
				return {
					storageKey: originalKey,
					playbackStorageKey,
					mimeType: validated.mimeType,
					playbackMimeType,
					sizeBytes: validated.sizeBytes,
					playbackSizeBytes,
					playbackStatus: playback.playbackStatus,
					playbackError: playback.playbackError,
					originalName,
					kind,
				};
			}

			let processed = {
				tmpPath: filePath,
				mimeType: validated.mimeType,
				ext: validated.ext,
				sizeBytes: validated.sizeBytes,
			};
			if ((kind === 'IMAGE' || kind === 'POSTER')
				&& validated.mimeType === 'application/pdf') {
				processed = await deps.processing.processPdf({ tmpPath: filePath });
			} else if (kind !== 'GAME') {
				processed = await deps.processing.processImage({
					tmpPath: filePath,
					mimeType: validated.mimeType,
					ext: validated.ext,
					sizeBytes: validated.sizeBytes,
				});
			}
			if (processed.tmpPath !== filePath) temporaryPaths.add(processed.tmpPath);

			const key = await upload(
				processed.tmpPath,
				kind,
				processed.ext,
				processed.mimeType,
				'original',
			);
			return {
				storageKey: key,
				mimeType: processed.mimeType,
				sizeBytes: processed.sizeBytes,
				originalName,
				kind,
			};
		},

		async rollbackCommitted() {
			const failures: unknown[] = [];
			for (const object of [...pendingObjects].reverse()) {
				try {
					await deps.deleteUnpersistedObject(
						object.bucket,
						object.key,
						`project-upload-unpersisted-${object.purpose}`,
						{ kind: object.kind },
					);
					pendingObjects.splice(pendingObjects.indexOf(object), 1);
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length > 0) {
				throw new AggregateError(
					failures,
					'Project upload durable rollback failed',
				);
			}
		},

		async cleanupTemp() {
			const failures: unknown[] = [];
			for (const temporaryPath of [...temporaryPaths]) {
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
		},
	};
}
