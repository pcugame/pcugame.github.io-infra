import type { Readable } from 'node:stream';

export type ImageUploadKind = 'IMAGE' | 'POSTER';
export type ImageRepresentationRole = 'ORIGINAL' | 'CARD_480' | 'DISPLAY_960';
export type ImageOwner =
	| { type: 'PROJECT'; id: string }
	| { type: 'EXHIBITION'; id: string };

/** String identities deliberately decouple the processor from Prisma numeric IDs. */
export interface VerifyingImageSession {
	id: string;
	kind: ImageUploadKind;
	state: 'VERIFYING';
	owner: ImageOwner;
	actorId: string;
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
}

export interface LocalImageOutput {
	role: ImageRepresentationRole;
	path: string;
	mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
	extension: 'jpg' | 'png' | 'webp';
	sizeBytes: number;
	width: number;
	height: number;
	checksumSha256: string;
}

export interface PreparedImageOutput {
	role: ImageRepresentationRole;
	bucket: string;
	objectKey: string;
	intentId: string;
	intentState: 'PREPARED' | 'UPLOADED';
}

export interface PreparedImagePlan {
	assetId: string;
	outputs: PreparedImageOutput[];
}

export interface ImageWorkerRepository {
	claimVerifying(kinds: readonly ImageUploadKind[], limit: number, token: string, leaseMs: number): Promise<VerifyingImageSession[]>;
	renewLease(sessionId: string, token: string, leaseMs: number): Promise<boolean>;
	prepareOutputPlan(input: {
		session: VerifyingImageSession;
		outputs: Array<Pick<LocalImageOutput, 'role' | 'extension' | 'mimeType' | 'width' | 'height'>>;
		notBefore: Date;
	}): Promise<PreparedImagePlan>;
	markOutputUploaded(intentId: string): Promise<void>;
	commitReady(input: {
		session: VerifyingImageSession;
		token: string;
		assetId: string;
		/** Queue the protected staging source for durable deletion in the same transaction. */
		sourceCleanup: { bucket: string; objectKey: string };
		outputs: Array<Omit<LocalImageOutput, 'path' | 'extension'> & { bucket: string; objectKey: string; intentId: string }>;
	}): Promise<void>;
	/** Rejects the session and queues its source plus all PREPARED/UPLOADED plan intents for cleanup atomically. */
	reject(input: { session: VerifyingImageSession; token: string; reason: string }): Promise<boolean>;
}

export interface ImageWorkerStorage {
	stream(bucket: string, key: string, signal?: AbortSignal): Promise<{ body: Readable; size: number }>;
	head(bucket: string, key: string, signal?: AbortSignal): Promise<{ size: number; checksumSha256?: string } | null>;
	upload(input: { bucket: string; key: string; body: Readable; contentType: string; contentLength: number; checksumSha256: string; signal?: AbortSignal }): Promise<void>;
}

export interface RasterInfo {
	width: number;
	height: number;
	pages: number;
	channels: number;
}

export interface ImageOperations {
	inspectRaster(path: string, signal?: AbortSignal): Promise<RasterInfo>;
	renderPdfFirstPage(inputPath: string, outputPath: string, signal?: AbortSignal): Promise<{ pages: number }>;
	createOutputs(input: {
		sourcePath: string;
		sourceMimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
		pdfRasterPath?: string;
		outputDirectory: string;
		signal?: AbortSignal;
	}): Promise<LocalImageOutput[]>;
}

export interface BoundedImageCommandRunner {
	run(input: { file: string; args: readonly string[]; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }>;
}
