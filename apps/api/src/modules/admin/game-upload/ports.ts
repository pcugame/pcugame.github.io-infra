import type {
	GameUploadCompleteResponse,
	SiteSettingsData,
	UploadKind,
	UserRole,
} from '@pcu/contracts';
import type { Readable } from 'node:stream';
import type { CompletedUploadSession } from './finalize-completed-upload.service.js';

/** Raised by the repository's serializable active-slot transaction. */
export class ActiveUploadCompletionInProgressError extends Error {
	constructor() {
		super('An upload session is already completing for this project and kind');
		this.name = 'ActiveUploadCompletionInProgressError';
	}
}

export interface GameUploadPartRecord {
	partNumber: number;
	etag: string;
}

export interface GameUploadSessionRecord {
	id: string;
	projectId: number;
	userId: number;
	uploadKind: UploadKind;
	originalName: string;
	totalBytes: bigint;
	chunkSizeBytes: number;
	totalChunks: number;
	uploadedChunks: number[];
	status: string;
	expiresAt: Date;
	s3UploadId: string | null;
	s3Key: string | null;
	parts: GameUploadPartRecord[];
	project: { status: string };
}

export interface GameUploadSessionSummary extends Omit<GameUploadSessionRecord, 'parts' | 'project'> {
	parts?: GameUploadPartRecord[];
	project?: { status: string };
}

export interface NewGameUploadSession {
	id: string;
	projectId: number;
	userId: number;
	uploadKind: UploadKind;
	originalName: string;
	totalBytes: bigint;
	chunkSizeBytes: number;
	totalChunks: number;
	s3UploadId: string;
	s3Key: string;
	expiresAt: Date;
}

export interface GameUploadRepository {
	findSessionById(id: string): Promise<GameUploadSessionRecord | null>;
	createSessionReplacingActive(data: NewGameUploadSession): Promise<{
		session: { id: string };
		replacedSessions: { id: string; s3UploadId: string | null; s3Key: string | null }[];
	}>;
	cancelSessionAndClearActive(id: string): Promise<{ count: number }>;
	upsertPartEtag(sessionId: string, partNumber: number, etag: string): Promise<GameUploadPartRecord[]>;
	transitionToCompleting(sessionId: string): Promise<{ count: number }>;
	findPartsBySessionId(sessionId: string): Promise<GameUploadPartRecord[]>;
	revertToPending(sessionId: string): Promise<unknown>;
	markFailed(sessionId: string, storageKey?: string | null): Promise<unknown>;
	findStaleCompletingSessions(cutoff: Date): Promise<GameUploadSessionSummary[]>;
	findActiveSessionsForListing(
		projectId: number,
		options: { userId?: number },
	): Promise<GameUploadSessionSummary[]>;
	findExhibitionById(id: number): Promise<{
		id: number;
		year: number;
		title: string;
		isUploadEnabled: boolean;
	} | null>;
}

export interface GameUploadStorage {
	createMultipart(key: string): Promise<string>;
	abortMultipart(key: string, uploadId: string): Promise<void>;
	uploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		body: Readable,
		contentLength: number,
	): Promise<string>;
	completeMultipart(key: string, uploadId: string, parts: GameUploadPartRecord[]): Promise<void>;
	head(key: string): Promise<{ size: number; contentType: string } | null>;
}

export interface GameUploadServiceDependencies {
	repository: GameUploadRepository;
	storage: GameUploadStorage;
	finalizer: {
		finalize(
			session: CompletedUploadSession,
			object: { size: number },
		): Promise<GameUploadCompleteResponse>;
	};
	settings: { get(): Promise<SiteSettingsData> };
	uploadSlots: { acquire(): void; release(): void };
	clock: { now(): Date };
	ids: { next(): string };
	lifecycle: { isAcceptingNewWork(): boolean };
	config: { uploadChunkSizeMb: number; uploadSessionTtlMinutes: number };
	roleGameMaxBytes(role: UserRole): number;
	storageKey(uploadKind: UploadKind, projectId: number): string;
	deleteOrQueue(key: string, reason: string, context: Record<string, unknown>): Promise<void>;
	logger: {
		error(context: Record<string, unknown>, message: string): void;
		warn(context: Record<string, unknown>, message: string): void;
	};
}
