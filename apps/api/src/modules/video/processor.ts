import { stat } from 'node:fs/promises';
import type {
	VerifyingVideoSession,
	VideoOperations,
	VideoWorkerRepository,
	VideoWorkerStorage,
} from './ports.js';
import type { VideoLimits } from './policy.js';
import {
	assertBrowserSafeOutput,
	assertSourceVideoPolicy,
	canRemuxVideo,
	isBrowserSafeVideo,
} from './policy.js';
import { materializeVideoWorkspace, sha256VideoFile } from './materialize.js';
import { errorMessage, VideoRejectedError } from './errors.js';
import { videoPlaybackObjectKey } from './playback-identity.js';

export type VideoProcessingStrategy = 'passthrough' | 'remux' | 'reencode';

export interface VideoProcessorDependencies {
	repository: VideoWorkerRepository;
	storage: VideoWorkerStorage;
	operations: VideoOperations;
	tempRoot: string;
	tempDiskBudgetBytes: number;
	protectedBucket: string;
	limits: VideoLimits;
	clock: { now(): Date };
	logger: {
		info(context: Record<string, unknown>, message: string): void;
		warn(context: Record<string, unknown>, message: string): void;
	};
}

export function createVideoProcessor(deps: VideoProcessorDependencies) {
	return {
		async process(
			session: VerifyingVideoSession,
			token: string,
			signal?: AbortSignal,
			assertOwned: () => Promise<void> = async () => undefined,
		): Promise<{
			strategy: VideoProcessingStrategy;
			assetId: number;
			playbackState: 'READY' | 'FAILED';
		}> {
			if (session.kind !== 'VIDEO' || session.state !== 'VERIFYING') {
				throw new Error('Video processor received an incompatible upload session');
			}
			if (session.bucket !== deps.protectedBucket) {
				throw new VideoRejectedError('VIDEO source is outside the protected bucket', 'CONTAINER_INVALID');
			}
			await assertOwned();
			const source = await deps.storage.stream(session.bucket, session.objectKey, signal);
			if (source.size !== Number(session.totalBytes)) {
				throw new VideoRejectedError('Completed VIDEO object size mismatch', 'SIZE_INVALID');
			}
			const workspace = await materializeVideoWorkspace({
				session,
				source: source.body,
				tempRoot: deps.tempRoot,
				maxSourceBytes: Math.min(deps.limits.maxSourceBytes, deps.tempDiskBudgetBytes),
				signal,
			});
			try {
				if (session.declaredMimeType && session.declaredMimeType !== workspace.mimeType) {
					deps.logger.warn({
						sessionId: session.id,
						declaredMimeType: session.declaredMimeType,
						detectedMimeType: workspace.mimeType,
					}, 'VIDEO declared MIME did not match validated magic bytes');
				}
				const probe = await deps.operations.probe(workspace.inputPath, signal);
				assertSourceVideoPolicy(probe, deps.limits);
				// Metadata probing alone is insufficient for truncated/corrupt streams.
				await deps.operations.verifyDecode(workspace.inputPath, signal);
				await assertOwned();

				let strategy: VideoProcessingStrategy = isBrowserSafeVideo(probe, deps.limits)
					? 'passthrough'
					: canRemuxVideo(probe, deps.limits) ? 'remux' : 'reencode';
				const playbackObjectKey = strategy === 'passthrough'
					? session.objectKey
					: videoPlaybackObjectKey(session);
				const originalReady = await deps.repository.commitVideoOriginalReady({
					session,
					token,
					originalMimeType: workspace.mimeType,
					originalSizeBytes: BigInt(workspace.sizeBytes),
					originalEtag: source.etag,
					playback: {
						bucket: deps.protectedBucket,
						objectKey: playbackObjectKey,
						mimeType: strategy === 'passthrough' ? workspace.mimeType : 'video/mp4',
					},
				});

				let playbackSize = workspace.sizeBytes;
				let playbackChecksumSha256: string | undefined;
				let intentId: string | undefined;
				if (strategy !== 'passthrough') {
					try {
						const outputBudget = Math.min(
							deps.limits.maxPlaybackBytes,
							deps.tempDiskBudgetBytes - workspace.sizeBytes,
						);
						if (!Number.isSafeInteger(outputBudget) || outputBudget < 1) {
							throw new VideoRejectedError('VIDEO playback exceeds the bounded worker temp-disk budget', 'RESOURCE_LIMIT');
						}
						if (strategy === 'remux') {
							try {
								await deps.operations.remux(
									workspace.inputPath,
									workspace.outputPath,
									outputBudget,
									signal,
								);
							} catch (error) {
								if (signal?.aborted) throw signal.reason ?? error;
								deps.logger.warn({ error, sessionId: session.id }, 'VIDEO remux failed; using bounded re-encode');
								strategy = 'reencode';
								await deps.operations.reencode(
									workspace.inputPath,
									workspace.outputPath,
									outputBudget,
									signal,
								);
							}
						} else {
							await deps.operations.reencode(
								workspace.inputPath,
								workspace.outputPath,
								outputBudget,
								signal,
							);
						}
						const output = await stat(workspace.outputPath);
						if (output.size < 1 || output.size > outputBudget) {
							throw new VideoRejectedError('Generated playback exceeded its output budget', 'RESOURCE_LIMIT');
						}
						const outputProbe = await deps.operations.probe(workspace.outputPath, signal);
						assertBrowserSafeOutput(outputProbe, deps.limits);
						playbackSize = output.size;
						playbackChecksumSha256 = await sha256VideoFile(workspace.outputPath, signal);
					} catch (error) {
						if (signal?.aborted) throw signal.reason ?? error;
						await assertOwned();
						const reason = `PLAYBACK_FAILED: ${errorMessage(error)}`;
						const failed = await deps.repository.commitVideoPlaybackFailed({
							session,
							token,
							assetId: originalReady.assetId,
							originalRepresentationId: originalReady.originalRepresentationId,
							playbackRepresentationId: originalReady.playbackRepresentationId,
							reason,
						});
						if (!failed) throw new Error('VIDEO playback failure fence lost', { cause: error });
						deps.logger.warn({
							error,
							sessionId: session.id,
							assetId: originalReady.assetId,
						}, 'VIDEO original is READY but playback generation failed');
						return {
							strategy,
							assetId: originalReady.assetId,
							playbackState: 'FAILED' as const,
						};
					}

					await assertOwned();
					const intent = await deps.repository.preparePlaybackIntent({
						session,
						bucket: deps.protectedBucket,
						objectKey: playbackObjectKey,
						notBefore: new Date(deps.clock.now().getTime() + 2 * 60 * 60_000),
					});
					intentId = intent.id;
					await assertOwned();
					const existing = await deps.storage.head(deps.protectedBucket, playbackObjectKey, signal);
					if (!existing || existing.size !== playbackSize
						|| existing.checksumSha256 !== playbackChecksumSha256) {
						await assertOwned();
						await deps.storage.upload({
							bucket: deps.protectedBucket,
							key: playbackObjectKey,
							body: workspace.readOutput(),
							contentType: 'video/mp4',
							contentLength: playbackSize,
							checksumSha256: playbackChecksumSha256,
							signal,
						});
					}
					await deps.repository.markPlaybackUploaded(intent.id);
				}

				await assertOwned();
				const ready = await deps.repository.commitVideoPlaybackReady({
					session,
					token,
					assetId: originalReady.assetId,
					originalRepresentationId: originalReady.originalRepresentationId,
					playbackRepresentationId: originalReady.playbackRepresentationId,
					playback: {
						bucket: deps.protectedBucket,
						objectKey: playbackObjectKey,
						mimeType: strategy === 'passthrough' ? workspace.mimeType : 'video/mp4',
						sizeBytes: BigInt(playbackSize),
						...(playbackChecksumSha256 ? { checksumSha256: playbackChecksumSha256 } : {}),
						intentId,
					},
				});
				deps.logger.info({
					sessionId: session.id,
					assetId: ready.assetId,
					strategy,
				}, 'Direct VIDEO processing committed canonical representations');
				return { strategy, assetId: ready.assetId, playbackState: 'READY' };
			} finally {
				await workspace.cleanup();
			}
		},
	};
}
