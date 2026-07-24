import type { AssetKind } from '@pcu/contracts';
import type { MultipartCommandInput } from '../../../application/http-input.js';
import type {
	ProcessedUpload,
	SingleAssetUploadCoordinator,
} from '../../../application/upload-ports.js';
import type { UploadLimits } from '../../../shared/upload-policy.js';
import { assertUploadAllowed } from '../upload-guard.js';
import type { ProjectAssetRepository } from './ports.js';

export interface ProjectAssetServiceDependencies {
	repository: ProjectAssetRepository;
	uploadLimits(role: MultipartCommandInput['actor']['role']): UploadLimits | Promise<UploadLimits>;
	uploadSlots: { acquire(): void; release(): void };
	uploadCoordinator: SingleAssetUploadCoordinator;
	assetUrl(storageKey: string, kind: AssetKind): string;
	bucketForKind(kind: AssetKind): string;
	/** Best-effort delete of an object already protected by the repository transaction's outbox. */
	deleteOrQueue(
		bucket: string,
		key: string,
		reason: string,
		context: Record<string, unknown>,
	): Promise<void>;
}

export function isReplaceableAssetKind(kind: AssetKind): boolean {
	return kind === 'GAME';
}

/**
 * Add a single asset to an existing project via multipart upload.
 * Handles GAME asset replacement logic.
 */
export async function addAssetToProject(
	deps: ProjectAssetServiceDependencies,
	projectId: number,
	exhibitionId: number,
	input: MultipartCommandInput,
) {
	const exhibition = await deps.repository.findExhibitionById(exhibitionId);
	assertUploadAllowed(exhibition, exhibitionId, input.actor.role);
	const limits = await deps.uploadLimits(input.actor.role);
	let upload: ProcessedUpload | null = null;
	let uploadPersisted = false;
	let response: { assetId: number; url: string } | undefined;
	let failure: unknown;

	deps.uploadSlots.acquire();
	try {
		upload = await deps.uploadCoordinator.start(input.parts, limits);
		const savedFile = upload.savedFile;

		// Replace existing GAME asset if uploading a new one. Other kinds, including VIDEO, always create.
		// DB write goes first — deletes of the prior S3 object happen only after commit so a mid-
		// flight failure can't leave the project pointing at a storageKey we already deleted.
		const isReplaceable = isReplaceableAssetKind(savedFile.kind);
		let assetId: number;
		let oldStorageKey: string | null = null;
		let oldPlaybackStorageKey: string | null = null;

		if (isReplaceable) {
			const bucket = deps.bucketForKind(savedFile.kind);
			const result = await deps.repository.replaceOrCreateReplaceableAsset(projectId, savedFile.kind, {
				storageKey: savedFile.storageKey,
				playbackStorageKey: savedFile.playbackStorageKey ?? null,
				originalName: savedFile.originalName,
				mimeType: savedFile.mimeType,
				playbackMimeType: savedFile.playbackMimeType ?? '',
				sizeBytes: BigInt(savedFile.sizeBytes),
				playbackSizeBytes: BigInt(savedFile.playbackSizeBytes ?? 0),
				playbackStatus: savedFile.playbackStatus,
				playbackError: savedFile.playbackError,
				isPublic: false,
			}, {
				bucket,
				reason: 'project-asset-replace-previous',
				playbackReason: 'project-asset-replace-previous-playback',
			});
			assetId = result.assetId;
			oldStorageKey = result.oldStorageKey;
			oldPlaybackStorageKey = result.oldPlaybackStorageKey;
			uploadPersisted = true;
		} else {
			const asset = await deps.repository.createAsset({
				projectId,
				kind: savedFile.kind,
				storageKey: savedFile.storageKey,
				playbackStorageKey: savedFile.playbackStorageKey ?? null,
				originalName: savedFile.originalName,
				mimeType: savedFile.mimeType,
				playbackMimeType: savedFile.playbackMimeType ?? '',
				sizeBytes: BigInt(savedFile.sizeBytes),
				playbackSizeBytes: BigInt(savedFile.playbackSizeBytes ?? 0),
				playbackStatus: savedFile.playbackStatus,
				playbackError: savedFile.playbackError,
				isPublic: savedFile.kind !== 'VIDEO',
			});
			assetId = asset.id;
			uploadPersisted = true;
		}

		if (oldStorageKey) {
			await deps.deleteOrQueue(deps.bucketForKind(savedFile.kind), oldStorageKey, 'project-asset-replace-previous', { assetId, kind: savedFile.kind });
		}
		if (oldPlaybackStorageKey) {
			await deps.deleteOrQueue(deps.bucketForKind(savedFile.kind), oldPlaybackStorageKey, 'project-asset-replace-previous-playback', { assetId, kind: savedFile.kind });
		}

		response = { assetId, url: deps.assetUrl(savedFile.storageKey, savedFile.kind) };
	} catch (err) {
		failure = err;
		if (upload && !uploadPersisted) {
			try {
				// The request pipeline is the sole owner of every unpersisted key
				// and its rollback is ticket-003 delete-or-durable-queue.
				await upload.rollback();
			} catch (rollbackError) {
				failure = new AggregateError(
					[err, rollbackError],
					'Project asset mutation and durable upload rollback failed',
				);
			}
		}
	} finally {
		deps.uploadSlots.release();
		if (upload) {
			try {
				await upload.cleanup();
			} catch (cleanupError) {
				failure = failure === undefined
					? cleanupError
					: new AggregateError(
							[failure, cleanupError],
							'Project asset request and temp cleanup failed',
						);
			}
		}
	}
	if (failure !== undefined) throw failure;
	return response!;
}

export function createProjectAssetService(deps: ProjectAssetServiceDependencies) {
	return {
		addAssetToProject: (
			projectId: number,
			exhibitionId: number,
			input: MultipartCommandInput,
		) => addAssetToProject(deps, projectId, exhibitionId, input),
	};
}
