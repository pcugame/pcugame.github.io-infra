import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { detectFileType, isAllowedVideoType } from '../../shared/file-signature.js';
import { materializeAndValidateCompletedSource } from '../admin/game-upload/source-identity.js';
import type { VerifyingVideoSession } from './ports.js';
import { VideoInfrastructureError, VideoRejectedError } from './errors.js';
import { cleanupStaleWorkerDirectories } from '../upload-lifecycle/worker-workspace.js';

const WORKSPACE_PREFIX = 'pcu-video-worker-';

export async function sha256VideoFile(filePath: string, signal?: AbortSignal): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filePath)) {
		if (signal?.aborted) throw signal.reason ?? new Error('VIDEO checksum was aborted');
		hash.update(chunk);
	}
	return hash.digest('hex');
}

export interface VideoWorkspace {
	directory: string;
	inputPath: string;
	outputPath: string;
	mimeType: string;
	ext: string;
	sizeBytes: number;
	readOutput(): Readable;
	cleanup(): Promise<void>;
}

function manifestBytes(value: unknown): Uint8Array {
	if (typeof value === 'string') return Buffer.from(value, 'base64');
	if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
		return Buffer.concat(value.map((part) => Buffer.from(part, 'hex')));
	}
	throw new VideoRejectedError('Persisted source identity manifest is malformed', 'CORRUPT_MEDIA');
}

export async function materializeVideoWorkspace(input: {
	session: VerifyingVideoSession;
	source: Readable;
	tempRoot: string;
	maxSourceBytes: number;
	signal?: AbortSignal;
}): Promise<VideoWorkspace> {
	const totalBytes = Number(input.session.totalBytes);
	if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > input.maxSourceBytes) {
		throw new VideoRejectedError('Video source size exceeds worker policy', 'SIZE_INVALID');
	}
	const root = resolve(input.tempRoot);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const directory = await mkdtemp(join(root, WORKSPACE_PREFIX));
	await chmod(directory, 0o700);
	const inputPath = join(directory, 'source.bin');
	const outputPath = join(directory, 'playback.mp4');
	try {
		await materializeAndValidateCompletedSource({
			totalBytes: input.session.totalBytes,
			sourceIdentityAlgorithm: input.session.sourceIdentityAlgorithm,
			sourceIdentity: input.session.sourceIdentity,
			sourceIdentityBlockSizeBytes: input.session.sourceIdentityBlockSizeBytes,
			sourceIdentityBlockManifest: manifestBytes(input.session.sourceIdentityBlockManifest),
			source: input.source,
			destination: createWriteStream(inputPath, { flags: 'wx', mode: 0o600 }),
			physicalByteLimit: input.maxSourceBytes,
			signal: input.signal,
		});
		const handle = await open(inputPath, 'r');
		let header: Buffer;
		try {
			header = Buffer.alloc(16);
			const result = await handle.read(header, 0, header.length, 0);
			header = header.subarray(0, result.bytesRead);
		} finally {
			await handle.close();
		}
		const detected = detectFileType(header);
		if (!detected || !isAllowedVideoType(detected)) {
			throw new VideoRejectedError('Video magic bytes are unsupported', 'MAGIC_INVALID');
		}
		return {
			directory,
			inputPath,
			outputPath,
			mimeType: detected.mime,
			ext: detected.ext,
			sizeBytes: totalBytes,
			readOutput: () => createReadStream(outputPath),
			cleanup: () => rm(directory, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
		if (input.signal?.aborted) throw input.signal.reason ?? error;
		if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
			throw new VideoInfrastructureError('Video worker temporary disk is full', { cause: error });
		}
		if (/source identity|source size|declared size|size mismatch|manifest/i.test(
			String(error instanceof Error ? error.message : error),
		)) {
			throw new VideoRejectedError('Completed video object does not match its declared source identity', 'SIZE_INVALID', { cause: error });
		}
		throw error;
	}
}

/** Removes only closed-grammar worker directories older than the cutoff. */
export async function cleanupStaleVideoWorkspaces(
	tempRoot: string,
	cutoff: Date,
): Promise<number> {
	return cleanupStaleWorkerDirectories({ tempRoot, prefix: WORKSPACE_PREFIX, cutoff });
}
