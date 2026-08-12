import type { Readable } from 'node:stream';
import type {
	ObjectStorage,
	UploadObjectOptions,
} from '../../../application/ports.js';
import type { UploadIntentOwner } from '../../../application/upload-ports.js';
import { settleUploadStreamFailure } from './upload-stream.js';

export interface IntentTrackedUploadIntentPort {
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
}

interface PendingObject {
	bucket: string;
	storageKey: string;
	reason: string;
	context?: Record<string, unknown>;
	intentId?: string;
}

export interface IntentTrackedObjectUploadInput {
	bucket: string;
	storageKey: string;
	purpose: string;
	owner?: UploadIntentOwner;
	createBody(): Readable;
	contentType: string;
	contentLength: number;
	storageOptions?: UploadObjectOptions;
	rollbackReason: string;
	rollbackContext?: Record<string, unknown>;
	logContext?: Record<string, unknown>;
}

export interface IntentTrackedObjectUploader {
	upload(input: IntentTrackedObjectUploadInput): Promise<{ intentId?: string }>;
	rollback(): Promise<void>;
}

/**
 * Request/item-owned PUT lifecycle shared by upload pipelines and maintenance.
 * Business transactions still own reference rows and intent commit; this
 * primitive owns only the non-transactional prepare/PUT/mark/rollback bridge.
 */
export function createIntentTrackedObjectUploader(deps: {
	storage: Pick<ObjectStorage, 'upload'>;
	uploadIntents?: IntentTrackedUploadIntentPort;
	deleteUnpersistedObject(target: PendingObject): Promise<void>;
	logger: { error(context: Record<string, unknown>, message: string): void };
	uploadStreamFailureMessage: string;
	rollbackFailureMessage: string;
	ambiguousErrorLogMessage: string;
}): IntentTrackedObjectUploader {
	const pendingObjects: PendingObject[] = [];

	return {
		async upload(input) {
			const intentId = await deps.uploadIntents?.prepare({
				bucket: input.bucket,
				storageKey: input.storageKey,
				purpose: input.purpose,
				...(input.owner?.operationId
					? { ownerOperationId: input.owner.operationId }
					: {}),
				...(input.owner?.actorId !== undefined
					? { ownerActorId: input.owner.actorId }
					: {}),
				...(input.owner?.projectId !== undefined
					? { ownerProjectId: input.owner.projectId }
					: {}),
				...(input.owner?.exhibitionId !== undefined
					? { ownerExhibitionId: input.owner.exhibitionId }
					: {}),
			});
			pendingObjects.push({
				bucket: input.bucket,
				storageKey: input.storageKey,
				reason: input.rollbackReason,
				...(input.rollbackContext ? { context: input.rollbackContext } : {}),
				...(intentId ? { intentId } : {}),
			});

			const body = input.createBody();
			try {
				await deps.storage.upload(
					input.bucket,
					input.storageKey,
					body,
					input.contentType,
					input.contentLength,
					input.storageOptions,
				);
			} catch (error) {
				const uploadFailure = await settleUploadStreamFailure(
					body,
					error,
					deps.uploadStreamFailureMessage,
				);
				if (intentId) {
					await deps.uploadIntents?.recordAmbiguousError(intentId, error).catch(
						(intentError) => deps.logger.error(
							{
								error: intentError,
								intentId,
								bucket: input.bucket,
								storageKey: input.storageKey,
								...input.logContext,
							},
							deps.ambiguousErrorLogMessage,
						),
					);
				}
				throw uploadFailure;
			}

			if (intentId) await deps.uploadIntents?.markUploaded(intentId);
			return intentId ? { intentId } : {};
		},

		async rollback() {
			const failures: unknown[] = [];
			for (const object of [...pendingObjects].reverse()) {
				try {
					if (object.intentId
						&& deps.uploadIntents
						&& !(await deps.uploadIntents.isUncommitted(object.intentId))) {
						pendingObjects.splice(pendingObjects.indexOf(object), 1);
						continue;
					}
					await deps.deleteUnpersistedObject(object);
					pendingObjects.splice(pendingObjects.indexOf(object), 1);
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length === 1) {
				throw failures[0];
			}
			if (failures.length > 1) {
				throw new AggregateError(failures, deps.rollbackFailureMessage);
			}
		},
	};
}
