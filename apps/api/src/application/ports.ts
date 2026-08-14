import type { Readable } from 'node:stream';
import type { SiteSettingsData } from '@pcu/contracts';
import type { UserRole } from '@pcu/contracts';

export interface UploadObjectOptions {
	contentDisposition?: string;
	contentEncoding?: string;
	cacheControl?: string;
	contentType?: string;
}

export interface ObjectStreamResult {
	body: Readable;
	size: number;
	contentType: string;
	contentEncoding?: string;
	cacheControl?: string;
	etag?: string;
	lastModified?: Date;
	contentRange?: string;
}

export interface CompletedPart {
	partNumber: number;
	etag: string;
}

export interface StoredObject {
	key: string;
	lastModified?: Date;
	size?: number;
}

export interface MultipartUpload {
	key: string;
	uploadId: string;
	initiated?: Date;
}

export interface StorageRequestOptions {
	signal?: AbortSignal;
	requestTimeoutMs?: number;
}

/** One lexically ordered S3 ListObjectsV2 page for destructive prefix work. */
export interface ObjectKeyPage {
	keys: string[];
	isTruncated: boolean;
}

/** A confirmed, per-object bulk deletion failure. */
export interface ObjectKeyDeleteFailure {
	key: string;
	code?: string;
	message?: string;
}

/** Every submitted key is accounted for exactly once by the adapter. */
export interface DeleteKeysResult {
	deleted: string[];
	failures: ObjectKeyDeleteFailure[];
}

/** Time is an input to application code, not hidden process state. */
export interface Clock {
	now(): Date;
}

/** UUID generation is injected so retries and tests can be deterministic. */
export interface IdGenerator {
	next(): string;
}

export interface AppLogger {
	child(bindings: Record<string, unknown>): AppLogger;
	trace(value: unknown, message?: string): void;
	debug(value: unknown, message?: string): void;
	info(value: unknown, message?: string): void;
	warn(value: unknown, message?: string): void;
	error(value: unknown, message?: string): void;
	fatal(value: unknown, message?: string): void;
}

export interface ScheduledTask {
	cancel(): void;
}

export interface Scheduler {
	every(intervalMs: number, task: () => void | Promise<void>): ScheduledTask;
	delay(ms: number): Promise<void>;
}

/** Framework-neutral subset of object storage used by application services. */
export interface ObjectStorage {
	upload(
		bucket: string,
		key: string,
		body: Buffer | Readable,
		contentType: string,
		contentLength?: number,
		options?: UploadObjectOptions,
		request?: StorageRequestOptions,
	): Promise<void>;
	presign(
		bucket: string,
		key: string,
		options?: { ttlSec?: number; responseContentDisposition?: string },
	): Promise<string>;
	delete(bucket: string, key: string, request?: StorageRequestOptions): Promise<void>;
	head(bucket: string, key: string, request?: StorageRequestOptions): Promise<{
		size: number;
		contentType: string;
		cacheControl?: string;
		etag?: string;
		lastModified?: Date;
	} | null>;
	readRange(
		bucket: string,
		key: string,
		start: number,
		end: number,
		request?: StorageRequestOptions,
	): Promise<Buffer>;
	stream(
		bucket: string,
		key: string,
		range?: { start: number; end: number },
		request?: StorageRequestOptions,
	): Promise<ObjectStreamResult | null>;
	listKeys(bucket: string, prefix: string, request?: StorageRequestOptions): Promise<string[]>;
	listKeyPage(
		bucket: string,
		prefix: string,
		page: { startAfter?: string; maxKeys: number },
		request?: StorageRequestOptions,
	): Promise<ObjectKeyPage>;
	deleteKeys(
		bucket: string,
		keys: readonly string[],
		request?: StorageRequestOptions,
	): Promise<DeleteKeysResult>;
	listObjects?(bucket: string, prefix: string, request?: StorageRequestOptions): Promise<StoredObject[]>;
	createMultipart(
		bucket: string,
		key: string,
		contentType?: string,
		options?: UploadObjectOptions,
		request?: StorageRequestOptions,
	): Promise<string>;
	uploadPart(
		bucket: string,
		key: string,
		uploadId: string,
		partNumber: number,
		body: Readable | Buffer,
		contentLength: number,
		request?: StorageRequestOptions,
	): Promise<string>;
	completeMultipart(
		bucket: string,
		key: string,
		uploadId: string,
		parts: CompletedPart[],
		request?: StorageRequestOptions,
	): Promise<void>;
	abortMultipart(
		bucket: string,
		key: string,
		uploadId: string,
		request?: StorageRequestOptions,
	): Promise<void>;
	listParts(
		bucket: string,
		key: string,
		uploadId: string,
		request?: StorageRequestOptions,
	): Promise<CompletedPart[]>;
	listMultipartUploads(
		bucket: string,
		prefix: string,
		request?: StorageRequestOptions,
	): Promise<MultipartUpload[]>;
}

export interface FileStat {
	size: number;
}

export interface DirectoryFile {
	name: string;
	path: string;
	lastModified?: Date;
}

/** Small filesystem port used by upload/export coordinators. */
export interface FileSystem {
	temporaryDirectory(): string;
	stat(path: string): Promise<FileStat>;
	access(path: string): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	readRange(path: string, start: number, end: number): Promise<Buffer>;
	createReadStream(path: string): Readable;
	createWriteStream(path: string): NodeJS.WritableStream;
	listFiles?(path: string): Promise<DirectoryFile[]>;
}

export interface GoogleIdentity {
	sub?: string;
	email?: string;
	name?: string;
	picture?: string;
	hd?: string;
}

export interface GoogleTokenVerifier {
	verify(credential: string, audiences: string[]): Promise<GoogleIdentity | undefined>;
}

export interface UploadLimiter {
	acquire(): void;
	release(): void;
}

export interface SettingsStore {
	get(): Promise<SiteSettingsData>;
	update(patch: Partial<SiteSettingsData>): Promise<SiteSettingsData>;
	invalidate(): void;
}

export type LifecycleState = 'starting' | 'ready' | 'draining' | 'shutting_down';

export interface Lifecycle {
	state(): LifecycleState;
	setState(state: LifecycleState): void;
	isAcceptingNewWork(): boolean;
	requestStarted(): void;
	requestFinished(): void;
	inFlight(): number;
	waitForDrain(timeoutMs: number): Promise<'drained' | 'timeout'>;
}

export interface DatabaseHealth {
	check(): Promise<boolean>;
}

export interface AuthSessionRecord {
	id: string;
	expiresAt: Date;
	lastSeenAt: Date;
	user: {
		id: number;
		googleSub: string;
		email: string;
		name: string;
		role: UserRole;
		studentId: string | null;
	};
}

export interface AuthSessionStore {
	find(id: string): Promise<AuthSessionRecord | null>;
	touch(id: string, lastSeenAt: Date): Promise<unknown>;
	delete(id: string): Promise<unknown>;
}

/** Process-scoped resources with explicit shutdown semantics (timers/caches). */
export interface ShutdownResource {
	start?(): void | Promise<void>;
	close(): void | Promise<void>;
}

/** Long-running process jobs exposed to the server through the composition root. */
export interface BackgroundMaintenance {
	recoverStaleUploads(signal?: AbortSignal): Promise<void>;
	purgeExpiredSessions(before: Date, signal?: AbortSignal): Promise<number>;
	reapOrphans(signal?: AbortSignal): Promise<void>;
}
