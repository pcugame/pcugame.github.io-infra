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
	): Promise<void>;
	presign(
		bucket: string,
		key: string,
		options?: { ttlSec?: number; responseContentDisposition?: string },
	): Promise<string>;
	delete(bucket: string, key: string): Promise<void>;
	head(bucket: string, key: string): Promise<{ size: number; contentType: string } | null>;
	readRange(bucket: string, key: string, start: number, end: number): Promise<Buffer>;
	stream(
		bucket: string,
		key: string,
		range?: { start: number; end: number },
	): Promise<ObjectStreamResult | null>;
	listKeys(bucket: string, prefix: string): Promise<string[]>;
	createMultipart(
		bucket: string,
		key: string,
		contentType?: string,
		options?: UploadObjectOptions,
	): Promise<string>;
	uploadPart(
		bucket: string,
		key: string,
		uploadId: string,
		partNumber: number,
		body: Readable | Buffer,
		contentLength: number,
	): Promise<string>;
	completeMultipart(
		bucket: string,
		key: string,
		uploadId: string,
		parts: CompletedPart[],
	): Promise<void>;
	abortMultipart(bucket: string, key: string, uploadId: string): Promise<void>;
}

export interface FileStat {
	size: number;
}

/** Small filesystem port used by upload/export coordinators. */
export interface FileSystem {
	temporaryDirectory(): string;
	stat(path: string): Promise<FileStat>;
	access(path: string): Promise<void>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	createReadStream(path: string): Readable;
	createWriteStream(path: string): NodeJS.WritableStream;
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
	close(): Promise<void>;
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
	close(): void | Promise<void>;
}

/** Long-running process jobs exposed to the server through the composition root. */
export interface BackgroundMaintenance {
	recoverStaleUploads(): Promise<void>;
	purgeExpiredSessions(before: Date): Promise<number>;
	reapOrphans(): Promise<void>;
}
