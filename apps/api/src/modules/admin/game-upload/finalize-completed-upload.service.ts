import type { GameUploadCompleteResponse, UploadKind } from '@pcu/contracts';
import { AppError, badRequest } from '../../../shared/errors.js';
import { detectFileType, isAllowedGameType } from '../../../shared/file-signature.js';
import type { WebglDeploymentKeys } from '../../webgl/paths.js';

export interface CompletedUploadSession {
	id: string;
	projectId: number;
	uploadKind: UploadKind;
	originalName: string;
	totalBytes: bigint;
	s3Key: string;
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
	readHeader(key: string): Promise<Buffer>;
	validateGameArchive(key: string, size: number): Promise<void>;
	deployWebgl(projectId: number, key: string, size: number): Promise<WebglDeploymentKeys>;
	cleanupWebglDeployment(keys: WebglDeploymentKeys, reason: string): Promise<void>;
	cleanupWebglEntry(projectId: number, entryKey: string, reason: string): Promise<void>;
	finalizeGame(
		session: CompletedUploadSession,
	): Promise<{ oldStorageKey: string | null; oldPlaybackStorageKey: string | null }>;
	finalizeWebgl(
		session: CompletedUploadSession,
		deployment: WebglDeploymentKeys,
	): Promise<{ oldEntryKey: string }>;
	deleteOrQueue(key: string, reason: string, context: Record<string, unknown>): Promise<void>;
	webglUrl(projectId: number): string;
	logError(context: Record<string, unknown>, message: string): void;
}) {
	return {
		async finalize(
			session: CompletedUploadSession,
			object: { size: number },
		): Promise<GameUploadCompleteResponse> {
			if (object.size !== Number(session.totalBytes)) {
				throw new AppError(
					500,
					`Final file size mismatch: expected ${session.totalBytes}, got ${object.size}`,
					'SIZE_MISMATCH',
				);
			}
			const detected = detectFileType(await deps.readHeader(session.s3Key));
			if (!detected || !isAllowedGameType(detected)) {
				throw badRequest('Uploaded file is not a valid ZIP archive');
			}

			if (session.uploadKind === 'WEBGL') {
				let deployment: WebglDeploymentKeys | null = null;
				try {
					deployment = await deps.deployWebgl(session.projectId, session.s3Key, object.size);
					const result = await deps.finalizeWebgl(session, deployment);
					if (result.oldEntryKey && result.oldEntryKey !== deployment.entryKey) {
						await deps.cleanupWebglEntry(
							session.projectId,
							result.oldEntryKey,
							'webgl-upload-replace-previous',
						).catch((err) => deps.logError(
							{ err, projectId: session.projectId, oldEntryKey: result.oldEntryKey },
							'Failed to clean previous WebGL deployment after pointer swap',
						));
					}
					return {
						status: 'COMPLETED',
						storageKey: session.s3Key,
						sizeBytes: Number(session.totalBytes),
						webglUrl: deps.webglUrl(session.projectId),
					};
				} catch (err) {
					if (deployment) {
						await deps.cleanupWebglDeployment(deployment, 'webgl-upload-finalization-failed');
					}
					throw err;
				}
			}

			await deps.validateGameArchive(session.s3Key, object.size);
			const result = await deps.finalizeGame(session);
			if (result.oldStorageKey) {
				await deps.deleteOrQueue(result.oldStorageKey, 'game-upload-replace-previous', { sessionId: session.id });
			}
			if (result.oldPlaybackStorageKey) {
				await deps.deleteOrQueue(
					result.oldPlaybackStorageKey,
					'game-upload-replace-previous-playback',
					{ sessionId: session.id },
				);
			}
			return {
				status: 'COMPLETED',
				storageKey: session.s3Key,
				sizeBytes: Number(session.totalBytes),
			};
		},
	};
}
