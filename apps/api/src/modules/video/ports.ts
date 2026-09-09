import type { Readable } from 'node:stream';

/** Structurally compatible with asset-upload/AssetUploadSessionRecord. */
export interface VerifyingVideoSession {
	id: string;
	projectId: number;
	userId: number;
	kind: 'VIDEO';
	state: 'VERIFYING';
	originalName: string;
	declaredMimeType: string;
	totalBytes: bigint;
	bucket: string;
	objectKey: string;
	generation: number;
	sourceIdentityAlgorithm: string;
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: number;
	sourceIdentityBlockManifest: unknown;
	validationLeaseToken: string | null;
	validationLeaseUntil: Date | null;
}

export interface GeneratedPlaybackIntent {
	id: string;
	state: 'PREPARED' | 'UPLOADED';
}

export interface VideoReadyResult {
	assetId: number;
	originalRepresentationId: string;
	playbackRepresentationId: string;
}

export interface VideoWorkerRepository {
	claimVideoVerifying(limit: number, token: string, leaseMs: number): Promise<VerifyingVideoSession[]>;
	renewVideoLease(sessionId: string, token: string, leaseMs: number): Promise<boolean>;
	preparePlaybackIntent(input: {
		session: VerifyingVideoSession;
		bucket: string;
		objectKey: string;
		notBefore: Date;
	}): Promise<GeneratedPlaybackIntent>;
	markPlaybackUploaded(intentId: string): Promise<void>;
	commitVideoReady(input: {
		session: VerifyingVideoSession;
		token: string;
		originalMimeType: string;
		originalSizeBytes: bigint;
		originalEtag?: string;
		playback: {
			bucket: string;
			objectKey: string;
			mimeType: string;
			sizeBytes: bigint;
			intentId?: string;
		};
	}): Promise<VideoReadyResult>;
	rejectVideo(input: {
		session: VerifyingVideoSession;
		token: string;
		reason: string;
		playbackIntentId?: string;
		playbackObjectKey?: string;
	}): Promise<boolean>;
}

export interface VideoWorkerStorage {
	stream(bucket: string, key: string, signal?: AbortSignal): Promise<{
		body: Readable;
		size: number;
		etag?: string;
	}>;
	head(bucket: string, key: string, signal?: AbortSignal): Promise<{ size: number; etag?: string } | null>;
	upload(input: {
		bucket: string;
		key: string;
		body: Readable;
		contentType: string;
		contentLength: number;
		signal?: AbortSignal;
	}): Promise<void>;
}

export interface CommandResult {
	stdout: string;
	stderr: string;
}

export interface BoundedCommandRunner {
	run(input: {
		file: string;
		args: readonly string[];
		timeoutMs: number;
		maxOutputBytes: number;
		signal?: AbortSignal;
	}): Promise<CommandResult>;
}

export interface VideoProbe {
	formatNames: string[];
	videoCodec: string;
	audioCodec: string;
	pixelFormat: string;
	width: number;
	height: number;
	frameRate: number;
	bitRate: number;
	durationSeconds: number;
	streamCount: number;
	videoStreamCount: number;
	audioStreamCount: number;
	fastStart: boolean;
}

export interface VideoOperations {
	probe(filePath: string, signal?: AbortSignal): Promise<VideoProbe>;
	verifyDecode(filePath: string, signal?: AbortSignal): Promise<void>;
	remux(inputPath: string, outputPath: string, maxOutputBytes: number, signal?: AbortSignal): Promise<void>;
	reencode(inputPath: string, outputPath: string, maxOutputBytes: number, signal?: AbortSignal): Promise<void>;
}
