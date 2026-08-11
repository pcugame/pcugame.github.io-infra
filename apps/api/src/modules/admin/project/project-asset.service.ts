import type { AssetKind } from '@pcu/contracts';
import { AppError } from '../../../shared/errors.js';
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
	logger?: {
		error(context: Record<string, unknown>, message: string): void;
	};
	recordPostCommitCleanupFailure?: () => void;
	idempotency?: {
		claim(input: {
			actorId: number;
			scope: string;
			key: string;
			requestHash: string;
		}): Promise<
			| { kind: 'acquired'; operationId: string; ownerToken: string }
			| { kind: 'succeeded'; result: unknown }
		>;
		markFailed(input: {
			operationId: string;
			ownerToken: string;
			terminal: boolean;
			error: unknown;
		}): Promise<void>;
		renew?(input: { operationId: string; ownerToken: string }): Promise<void>;
	};
}

function storedAssetResult(value: unknown): { assetId: number; url: string } | null {
	if (!value || typeof value !== 'object') return null;
	const result = value as Record<string, unknown>;
	return typeof result.assetId === 'number' && typeof result.url === 'string'
		? { assetId: result.assetId, url: result.url }
		: null;
}

class AssetIdempotencyReplay extends Error {
	constructor(readonly result: { assetId: number; url: string }) {
		super('Asset idempotency replay');
		this.name = 'AssetIdempotencyReplay';
	}
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
	let operation: { operationId: string; ownerToken: string } | undefined;
	let operationHeartbeat: NodeJS.Timeout | undefined;
	const stopOperationHeartbeat = () => {
		if (operationHeartbeat) clearInterval(operationHeartbeat);
		operationHeartbeat = undefined;
	};

	deps.uploadSlots.acquire();
	try {
		upload = await deps.uploadCoordinator.start(
			input.parts,
			limits,
			{
				actorId: input.actor.id,
				projectId,
				exhibitionId,
			},
			input.idempotencyKey && deps.idempotency
				? async (requestHash) => {
					const claimed = await deps.idempotency!.claim({
						actorId: input.actor.id,
						scope: `project-asset:${projectId}`,
						key: input.idempotencyKey!,
						requestHash,
					});
					if (claimed.kind === 'succeeded') {
						const stored = storedAssetResult(claimed.result);
						if (!stored) throw new Error('Stored asset idempotency result is malformed');
						throw new AssetIdempotencyReplay(stored);
					}
					operation = claimed;
					if (deps.idempotency!.renew) {
						operationHeartbeat = setInterval(() => {
							void deps.idempotency!.renew!(operation!).catch((error) => {
								deps.logger?.error(
									{ error, operationId: operation?.operationId },
									'Idempotency operation heartbeat failed',
								);
							});
						}, 30 * 1000);
						operationHeartbeat.unref();
					}
					return {
						operationId: claimed.operationId,
						actorId: input.actor.id,
						projectId,
						exhibitionId,
					};
				}
				: undefined,
		);
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
				uploadIntentIds: savedFile.uploadIntentIds,
				...(operation ? {
					idempotency: {
						...operation,
						resultForAsset: (createdAssetId: number) => ({
							assetId: createdAssetId,
							url: deps.assetUrl(savedFile.storageKey, savedFile.kind),
						}),
					},
				} : {}),
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
				uploadIntentIds: savedFile.uploadIntentIds,
				...(operation ? {
					idempotency: {
						...operation,
						resultForAsset: (createdAssetId: number) => ({
							assetId: createdAssetId,
							url: deps.assetUrl(savedFile.storageKey, savedFile.kind),
						}),
					},
				} : {}),
			});
			assetId = asset.id;
			uploadPersisted = true;
		}
		response = { assetId, url: deps.assetUrl(savedFile.storageKey, savedFile.kind) };
		stopOperationHeartbeat();

		if (oldStorageKey) {
			await deps.deleteOrQueue(
				deps.bucketForKind(savedFile.kind),
				oldStorageKey,
				'project-asset-replace-previous',
				{ assetId, kind: savedFile.kind },
			).catch((error) => {
				deps.recordPostCommitCleanupFailure?.();
				deps.logger?.error(
					{ error, assetId, kind: savedFile.kind, storageKey: oldStorageKey },
					'Post-commit asset cleanup failed; durable outbox retained',
				);
			});
		}
		if (oldPlaybackStorageKey) {
			await deps.deleteOrQueue(
				deps.bucketForKind(savedFile.kind),
				oldPlaybackStorageKey,
				'project-asset-replace-previous-playback',
				{ assetId, kind: savedFile.kind },
			).catch((error) => {
				deps.recordPostCommitCleanupFailure?.();
				deps.logger?.error(
					{ error, assetId, kind: savedFile.kind, storageKey: oldPlaybackStorageKey },
					'Post-commit asset playback cleanup failed; durable outbox retained',
				);
			});
		}
	} catch (err) {
		stopOperationHeartbeat();
		if (err instanceof AssetIdempotencyReplay) {
			response = err.result;
			return response;
		}
		failure = err;
		if (operation && deps.idempotency) {
			await deps.idempotency.markFailed({
				...operation,
				terminal: err instanceof AppError
					&& err.statusCode >= 400
					&& err.statusCode < 500
					&& err.statusCode !== 409,
				error: err,
			}).catch((markError) => deps.logger?.error(
				{ error: markError, operationId: operation?.operationId },
				'Failed to persist asset idempotency failure',
			));
		}
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
		stopOperationHeartbeat();
		deps.uploadSlots.release();
		if (upload) {
			try {
				await upload.cleanup();
			} catch (cleanupError) {
				if (response !== undefined && failure === undefined) {
					deps.recordPostCommitCleanupFailure?.();
					deps.logger?.error(
						{ error: cleanupError, assetId: response.assetId },
						'Post-commit asset temp cleanup failed',
					);
				} else {
					failure = failure === undefined ? cleanupError : new AggregateError(
							[failure, cleanupError],
							'Project asset request and temp cleanup failed',
						);
				}
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
