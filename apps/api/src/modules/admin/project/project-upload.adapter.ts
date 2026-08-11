import type { AssetKind } from '@pcu/contracts';
import type {
	AppLogger,
	FileSystem,
	IdGenerator,
	ObjectStorage,
} from '../../../application/ports.js';
import type {
	SavedUpload,
	UploadIntentOwner,
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

interface PendingObject {
	bucket: string;
	key: string;
	kind: AssetKind;
	purpose: 'original' | 'playback';
	intentId?: string;
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
	let owner: UploadIntentOwner = {};

	async function upload(
		filePath: string,
		kind: AssetKind,
		extension: string,
		contentType: string,
		purpose: PendingObject['purpose'],
	): Promise<{ key: string; intentId?: string }> {
		const bucket = deps.bucketForKind(kind);
		const key = storageKey(deps.ids.next(), extension);
		const stat = await deps.fileSystem.stat(filePath);
		const intentId = await deps.uploadIntents?.prepare({
			bucket,
			storageKey: key,
			purpose: `project-${kind.toLowerCase()}-${purpose}`,
			...(owner.operationId ? { ownerOperationId: owner.operationId } : {}),
			...(owner.actorId !== undefined ? { ownerActorId: owner.actorId } : {}),
			...(owner.projectId !== undefined ? { ownerProjectId: owner.projectId } : {}),
			...(owner.exhibitionId !== undefined
				? { ownerExhibitionId: owner.exhibitionId }
				: {}),
		});
		pendingObjects.push({ bucket, key, kind, purpose, ...(intentId ? { intentId } : {}) });
		try {
			await deps.storage.upload(
				bucket,
				key,
				deps.fileSystem.createReadStream(filePath),
				contentType,
				stat.size,
				storageOptionsForAsset(kind, purpose),
			);
		} catch (error) {
			if (intentId) await deps.uploadIntents?.recordAmbiguousError(intentId, error).catch(
				(intentError) => deps.logger.error(
					{ error: intentError, intentId, bucket, storageKey: key },
					'Failed to annotate ambiguous upload intent',
				),
			);
			throw error;
		}
		if (intentId) await deps.uploadIntents?.markUploaded(intentId);
		return { key, ...(intentId ? { intentId } : {}) };
	}

	return {
		setOwner(nextOwner) {
			owner = { ...nextOwner };
		},
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

				const original = await upload(
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
					const playbackUpload = await upload(
						playback.playback.tmpPath,
						kind,
						playback.playback.ext,
						playback.playback.mimeType,
						'playback',
					);
					playbackStorageKey = playbackUpload.key;
					playbackMimeType = playback.playback.mimeType;
					playbackSizeBytes = playback.playback.sizeBytes;
				}
				return {
					storageKey: original.key,
					playbackStorageKey,
					mimeType: validated.mimeType,
					playbackMimeType,
					sizeBytes: validated.sizeBytes,
					playbackSizeBytes,
					playbackStatus: playback.playbackStatus,
					playbackError: playback.playbackError,
					originalName,
					kind,
					uploadIntentIds: [original.intentId, ...pendingObjects
						.filter((item) => item.key === playbackStorageKey)
						.map((item) => item.intentId)]
						.filter((id): id is string => typeof id === 'string'),
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

			const uploaded = await upload(
				processed.tmpPath,
				kind,
				processed.ext,
				processed.mimeType,
				'original',
			);
			return {
				storageKey: uploaded.key,
				mimeType: processed.mimeType,
				sizeBytes: processed.sizeBytes,
				originalName,
				kind,
				uploadIntentIds: uploaded.intentId ? [uploaded.intentId] : [],
			};
		},

		async rollbackCommitted() {
			const failures: unknown[] = [];
			for (const object of [...pendingObjects].reverse()) {
				try {
					if (object.intentId
						&& deps.uploadIntents
						&& !(await deps.uploadIntents.isUncommitted(object.intentId))) {
						pendingObjects.splice(pendingObjects.indexOf(object), 1);
						continue;
					}
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
