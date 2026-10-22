import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import type { createPlaybackRepository } from './playback.repository.js';
import { sourceVersion } from './playback.repository.js';
import type { VideoOperations, VideoWorkerStorage } from './ports.js';
import { assertBrowserSafeOutput, assertSourceVideoPolicy, canRemuxVideo, isBrowserSafeVideo, playbackRenditions, playbackQualityBounds, type VideoLimits } from './policy.js';
import { sha256VideoFile } from './materialize.js';
import { createClaimHeartbeatGuard } from '../upload-lifecycle/claim-heartbeat.js';

export function createPlaybackWorker(deps: {
	repository: ReturnType<typeof createPlaybackRepository>;
	storage: VideoWorkerStorage;
	operations: VideoOperations;
	limits: VideoLimits;
	tempRoot: string;
	tempDiskBudgetBytes: number;
	logger: { error(context: Record<string, unknown>, message: string): void };
}) {
	return {
		async runPass(signal?: AbortSignal) {
			await deps.repository.cleanup();
			const job = await deps.repository.claim();
			const result = { claimed: job ? 1 : 0, ready: 0, rejected: 0, retried: 0 };
			if(!job) return result;
			const token = job.leaseToken!;
			const claim = createClaimHeartbeatGuard({
				heartbeatMs: 30_000, outerSignal: signal,
				lostMessage: 'Playback job lease lost', renew: () => deps.repository.renew(job.id, token),
				logHeartbeatFailure: error => deps.logger.error({ error, jobId: job.id }, 'Playback heartbeat failed')
			});
			let dir: string | undefined;
			try {
				await claim.assertOwned();
				if(job.attempts > 3) throw new Error('OPERATOR_REQUIRED: playback retry budget exhausted');
				const original = job.asset?.representations.find(r => r.role === 'ORIGINAL' && r.state === 'READY');
				if(!original || job.asset?.status !== 'READY' || sourceVersion(original) !== job.sourceVersion) throw new Error('SOURCE_CHANGED: original representation changed');
				const source = await deps.storage.stream(job.sourceBucket, job.sourceObjectKey, claim.signal);
				if(source.size !== Number(original.sizeBytes)) { source.body.destroy(); throw new Error('SOURCE_CHANGED: size mismatch'); }
				if(original.etag && source.etag && original.etag.replaceAll('"', '') !== source.etag.replaceAll('"', '')) {
					source.body.destroy(); throw new Error('SOURCE_CHANGED: etag mismatch');
				}
				await mkdir(deps.tempRoot, { recursive: true });
				dir = await mkdtemp(join(deps.tempRoot, 'pcu-video-worker-'));
				const inputPath = join(dir, 'source');
				const outputPath = join(dir, 'playback.mp4');
				let bytes = 0;
				const hash = createHash('sha256');
				await pipeline(source.body, new Transform({
					transform(chunk: Buffer, _encoding, callback) {
						bytes += chunk.length;
						if(bytes > Math.min(deps.limits.maxSourceBytes, deps.tempDiskBudgetBytes)) return callback(new Error('Source exceeds disk budget'));
						hash.update(chunk); callback(null, chunk);
					}
				}), createWriteStream(inputPath), { signal: claim.signal });
				if(bytes !== source.size) throw new Error('SOURCE_CHANGED: incomplete source');
				const digest = hash.digest('hex');
				if(original.checksumAlgorithm === 'SHA256' && original.checksum && original.checksum !== digest && original.checksum !== Buffer.from(digest, 'hex').toString('base64')) throw new Error('SOURCE_CHANGED: stored checksum mismatch');
				await deps.repository.bindSource(job.id, token, digest);
				const probe = await deps.operations.probe(inputPath, claim.signal);
				assertSourceVideoPolicy(probe, deps.limits);
				await deps.operations.verifyDecode(inputPath, claim.signal);
				const outputs = [];
				for(const { profile, divisor, quality, key: renditionKey } of playbackRenditions(probe, deps.limits)) {
					await claim.assertOwned();
					const passthrough = quality === 'max' && profile === 'native' && isBrowserSafeVideo(probe, deps.limits);
					const key = passthrough ? job.sourceObjectKey : `protected/video-playbacks/${job.id}/${token}/${renditionKey}.mp4`;
					const candidate = await deps.repository.prepare(job.id, token, renditionKey, job.sourceBucket, key);
					let path = inputPath;
					if(!passthrough) {
						const budget = Math.min(deps.limits.maxPlaybackBytes, deps.tempDiskBudgetBytes - bytes);
						if(budget < 1) throw new Error('Playback exceeds disk budget');
						if(quality === 'max' && profile === 'native' && canRemuxVideo(probe, deps.limits)) {
							try { await deps.operations.remux(inputPath, outputPath, budget, claim.signal); }
							catch(error) { if(claim.signal.aborted) throw error; await deps.operations.reencode(inputPath, outputPath, budget, claim.signal, divisor, quality); }
						} else await deps.operations.reencode(inputPath, outputPath, budget, claim.signal, divisor, quality);
						path = outputPath;
						if((await stat(path)).size > budget) throw new Error('Playback exceeded output budget');
						if(!deps.operations.verifyPlayback) throw new Error('Playback timing validator unavailable');
						await deps.operations.verifyPlayback(inputPath, outputPath, divisor, claim.signal);
					}
					const output = passthrough ? probe : await deps.operations.probe(path, claim.signal);
					assertBrowserSafeOutput(output, deps.limits);
                    const bounds = playbackQualityBounds(quality, deps.limits);
                    if (output.width > Math.min(bounds.width, probe.width) || output.height > Math.min(bounds.height, probe.height)) {
                        throw new Error('Generated playback exceeds its resolution bounds');
                    }
					if ((profile === 'cap60' && output.frameRate > 60.001) || (profile === 'cap30' && output.frameRate > 30.001)) {
						throw new Error('Generated playback exceeds its frame-rate profile');
					}
					const size = (await stat(path)).size;
					const checksum = passthrough ? digest : await sha256VideoFile(path, claim.signal);
					if(!passthrough) {
						await claim.assertOwned();
						await deps.storage.upload({
							bucket: job.sourceBucket, key, body: createReadStream(path), contentLength: size,
							contentType: 'video/mp4', checksumSha256: checksum, signal: claim.signal
						});
						const uploaded = await deps.storage.head(job.sourceBucket, key, claim.signal);
						if(!uploaded || uploaded.size !== size || uploaded.checksumSha256 !== checksum) throw new Error('Playback upload checksum mismatch');
					}
					outputs.push({ id: candidate.id, checksum, sizeBytes: BigInt(size), frameRate: output.frameRate, width: output.width, height: output.height });
					if(!passthrough) await rm(outputPath, { force: true });
				}
				const currentSource = await deps.storage.head(job.sourceBucket, job.sourceObjectKey, claim.signal);
				if(!currentSource || currentSource.size !== bytes || (source.etag && currentSource.etag !== source.etag) || (currentSource?.checksumSha256 && currentSource.checksumSha256 !== digest)) throw new Error('SOURCE_CHANGED: object replaced while processing');
				await claim.assertOwned();
				await deps.repository.complete(job.id, token, outputs);
				result.ready++;
			} catch(error) {
				if(claim.isLost() || signal?.aborted) result.retried++;
				else {
					await deps.repository.fail(job.id, token, error instanceof Error ? error.message : String(error));
					result.rejected++;
					deps.logger.error({ error, jobId: job.id }, 'Playback generation failed; previous playback retained');
				}
			} finally {
				claim.stop();
				if(dir) await rm(dir, { recursive: true, force: true });
			}
			return result;
		},
	};
}
