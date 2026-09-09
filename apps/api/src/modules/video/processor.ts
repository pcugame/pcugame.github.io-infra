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
import { materializeVideoWorkspace } from './materialize.js';
import { VideoRejectedError } from './errors.js';

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

function playbackKey(session: VerifyingVideoSession): string {
	const safeSession = Buffer.from(session.id, 'utf8').toString('base64url');
	return `protected/assets/video/${session.projectId}/${safeSession}/g${session.generation}/playback.mp4`;
}

export function createVideoProcessor(deps: VideoProcessorDependencies) {
	return {
		async process(
			session: VerifyingVideoSession,
			token: string,
			signal?: AbortSignal,
			assertOwned: () => Promise<void> = async () => undefined,
		): Promise<{ strategy: VideoProcessingStrategy; assetId: number }> {
			if (session.kind !== 'VIDEO' || session.state !== 'VERIFYING') {
				throw new Error('Video processor received an incompatible upload session');
			}
			if (session.bucket !== deps.protectedBucket) {
				throw new VideoRejectedError('VIDEO source is outside the protected bucket', 'CONTAINER_INVALID');
			}
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

				let strategy: VideoProcessingStrategy;
				let playbackObjectKey = session.objectKey;
				let playbackSize = workspace.sizeBytes;
				let intentId: string | undefined;
				if (isBrowserSafeVideo(probe, deps.limits)) {
					strategy = 'passthrough';
				} else {
					const outputBudget = Math.min(
						deps.limits.maxPlaybackBytes,
						deps.tempDiskBudgetBytes - workspace.sizeBytes,
					);
					if (!Number.isSafeInteger(outputBudget) || outputBudget < 1) {
						throw new VideoRejectedError('VIDEO exceeds the bounded worker temp-disk budget', 'RESOURCE_LIMIT');
					}
					if (canRemuxVideo(probe, deps.limits)) {
						strategy = 'remux';
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
						strategy = 'reencode';
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
					await assertOwned();
					playbackObjectKey = playbackKey(session);
					playbackSize = output.size;
					const intent = await deps.repository.preparePlaybackIntent({
						session,
						bucket: deps.protectedBucket,
						objectKey: playbackObjectKey,
						notBefore: new Date(deps.clock.now().getTime() + 2 * 60 * 60_000),
					});
					intentId = intent.id;
					const existing = await deps.storage.head(deps.protectedBucket, playbackObjectKey, signal);
					if (!existing || existing.size !== playbackSize) {
						await deps.storage.upload({
							bucket: deps.protectedBucket,
							key: playbackObjectKey,
							body: workspace.readOutput(),
							contentType: 'video/mp4',
							contentLength: playbackSize,
							signal,
						});
					}
					await deps.repository.markPlaybackUploaded(intent.id);
				}

				await assertOwned();
				const ready = await deps.repository.commitVideoReady({
					session,
					token,
					originalMimeType: workspace.mimeType,
					originalSizeBytes: BigInt(workspace.sizeBytes),
					originalEtag: source.etag,
					playback: {
						bucket: deps.protectedBucket,
						objectKey: playbackObjectKey,
						mimeType: strategy === 'passthrough' ? workspace.mimeType : 'video/mp4',
						sizeBytes: BigInt(playbackSize),
						intentId,
					},
				});
				deps.logger.info({
					sessionId: session.id,
					assetId: ready.assetId,
					strategy,
				}, 'Direct VIDEO processing committed canonical representations');
				return { strategy, assetId: ready.assetId };
			} finally {
				await workspace.cleanup();
			}
		},
	};
}
