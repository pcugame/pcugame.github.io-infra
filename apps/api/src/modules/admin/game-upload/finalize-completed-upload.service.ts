import type { GameUploadCompleteResponse, UploadKind } from '@pcu/contracts';
import type { StorageRequestOptions } from '../../../application/ports.js';
import { AppError, badRequest } from '../../../shared/errors.js';
import { detectFileType, isAllowedGameType } from '../../../shared/file-signature.js';
import type { WebglDeploymentKeys, WebglPublicDeploymentKeys } from '../../webgl/paths.js';

export interface CompletedUploadSession {
	id: string;
	projectId: number;
	uploadKind: UploadKind;
	originalName: string;
	totalBytes: bigint;
	s3Key: string;
	completionClaimToken: string;
}

export interface CompletedUploadFinalizationOptions {
	storageRequest?: StorageRequestOptions;
	assertClaimOwned?: () => Promise<void>;
}

/**
 * Only deterministic validation failures are safe to make terminal. Unknown
 * storage/DB failures keep the completed source object for restart recovery.
 */
export function isTerminalUploadFinalizationError(error: unknown): boolean {
	return error instanceof AppError
		&& (error.code === 'SIZE_MISMATCH' || (error.statusCode >= 400 && error.statusCode < 500));
}

export function createCompletedUploadFinalizer(deps: {
	readHeader(key: string, request?: StorageRequestOptions): Promise<Buffer>;
	validateGameArchive(key: string, size: number, request?: StorageRequestOptions): Promise<void>;
	deployWebgl(
		projectId: number,
		key: string,
		size: number,
		options?: CompletedUploadFinalizationOptions,
	): Promise<WebglDeploymentKeys>;
	rollbackWebglPublicDeployment(
		keys: WebglPublicDeploymentKeys,
		reason: string,
		options?: CompletedUploadFinalizationOptions,
	): Promise<void>;
	finalizeGame(
		session: CompletedUploadSession,
	): Promise<{ oldStorageKey: string | null; oldPlaybackStorageKey: string | null }>;
	finalizeWebgl(
		session: CompletedUploadSession,
		deployment: WebglDeploymentKeys,
	): Promise<{ oldEntryKey: string }>;
	wakeDeletionWorker(): void;
	webglUrl(projectId: number): string;
	logError(context: Record<string, unknown>, message: string): void;
}) {
	return {
		async finalize(
			session: CompletedUploadSession,
			object: { size: number },
			options: CompletedUploadFinalizationOptions = {},
		): Promise<GameUploadCompleteResponse> {
			await options.assertClaimOwned?.();
			if (object.size !== Number(session.totalBytes)) {
				throw new AppError(
					500,
					`Final file size mismatch: expected ${session.totalBytes}, got ${object.size}`,
					'SIZE_MISMATCH',
				);
			}
			const detected = detectFileType(await deps.readHeader(
				session.s3Key,
				options.storageRequest,
			));
			await options.assertClaimOwned?.();
			if (!detected || !isAllowedGameType(detected)) {
				throw badRequest('Uploaded file is not a valid ZIP archive');
			}

			if (session.uploadKind === 'WEBGL') {
				let deployment: WebglDeploymentKeys | null = null;
				let pointerFinalized = false;
				try {
					await options.assertClaimOwned?.();
					deployment = await deps.deployWebgl(
						session.projectId,
						session.s3Key,
						object.size,
						options,
					);
					await options.assertClaimOwned?.();
					const result = await deps.finalizeWebgl(session, deployment);
					pointerFinalized = true;
					if (result.oldEntryKey && result.oldEntryKey !== deployment.entryKey) {
						deps.wakeDeletionWorker();
					}
					return {
						status: 'COMPLETED',
						storageKey: session.s3Key,
						sizeBytes: Number(session.totalBytes),
						webglUrl: deps.webglUrl(session.projectId),
					};
				} catch (err) {
					if (deployment && !pointerFinalized) {
						let stillOwnsClaim = !options.storageRequest?.signal?.aborted;
						if (stillOwnsClaim && options.assertClaimOwned) {
							try {
								await options.assertClaimOwned();
							} catch {
								stillOwnsClaim = false;
							}
						}
						if (stillOwnsClaim) {
							if (options.storageRequest || options.assertClaimOwned) {
								await deps.rollbackWebglPublicDeployment(
									deployment,
									'webgl-upload-finalization-failed-site',
									options,
								);
							} else {
								await deps.rollbackWebglPublicDeployment(
									deployment,
									'webgl-upload-finalization-failed-site',
								);
							}
						} else {
							deps.logError(
								{ error: err, sessionId: session.id, projectId: session.projectId },
								'WebGL completion claim was lost; retaining deployment for reference-aware reconciliation',
							);
						}
					}
					throw err;
				}
			}

			await deps.validateGameArchive(
				session.s3Key,
				object.size,
				options.storageRequest,
			);
			await options.assertClaimOwned?.();
			const result = await deps.finalizeGame(session);
			if (result.oldStorageKey || result.oldPlaybackStorageKey) deps.wakeDeletionWorker();
			return {
				status: 'COMPLETED',
				storageKey: session.s3Key,
				sizeBytes: Number(session.totalBytes),
			};
		},
	};
}
