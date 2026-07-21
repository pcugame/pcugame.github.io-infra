import type { AssetKind } from '@pcu/contracts';
import type { MultipartCommandInput } from '../../../application/http-input.js';
import type { ProcessedUpload, SingleAssetUploadCoordinator } from '../../../application/upload-ports.js';
import type { UploadLimits } from '../../../shared/upload-limits.js';
import { assertUploadAllowed } from '../upload-guard.js';
import type { ProjectAssetRepository } from './ports.js';

export interface ProjectAssetServiceDependencies {
	repository: ProjectAssetRepository;
	uploadLimits(role: MultipartCommandInput['actor']['role']): UploadLimits;
	uploadSlots: { acquire(): void; release(): void };
	uploadCoordinator: SingleAssetUploadCoordinator;
	assetUrl(storageKey: string, kind: AssetKind): string;
	bucketForKind(kind: AssetKind): string;
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
	const limits = deps.uploadLimits(input.actor.role);
	let upload: ProcessedUpload | null = null;

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
			});
			assetId = result.assetId;
			oldStorageKey = result.oldStorageKey;
			oldPlaybackStorageKey = result.oldPlaybackStorageKey;
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
		}

		if (oldStorageKey) {
			await deps.deleteOrQueue(deps.bucketForKind(savedFile.kind), oldStorageKey, 'project-asset-replace-previous', { assetId, kind: savedFile.kind });
		}
		if (oldPlaybackStorageKey) {
			await deps.deleteOrQueue(deps.bucketForKind(savedFile.kind), oldPlaybackStorageKey, 'project-asset-replace-previous-playback', { assetId, kind: savedFile.kind });
		}

		return { assetId, url: deps.assetUrl(savedFile.storageKey, savedFile.kind) };
	} catch (err) {
		if (upload) await upload.rollback();
		throw err;
	} finally {
		deps.uploadSlots.release();
		if (upload) await upload.cleanup();
	}
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
