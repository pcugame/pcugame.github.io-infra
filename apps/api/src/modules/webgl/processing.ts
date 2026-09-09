import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { validateBoundedZipFile, ZipValidationError, type BoundedZipValidationOptions } from '../archive/bounded-zip-validator.js';
import { AppError } from '../../shared/errors.js';
import { decodePersistedSourceIdentityManifest, materializeAndValidateCompletedSource } from '../admin/game-upload/source-identity.js';
import { analyzeWebglArchive, uploadWebglArchive, type WebglPublicObjectUploader } from './archive.js';
import { webglContentMetadata } from './content.js';
import { createCanonicalWebglPublicKeys } from './paths.js';

export interface CanonicalWebglSourceRepresentation {
	id: string;
	assetId: number;
	role: 'WEBGL_SOURCE';
	state: 'VERIFYING';
	bucket: string;
	objectKey: string;
	sizeBytes: bigint;
	updatedAt: Date;
	sourceIdentityAlgorithm: string;
	sourceIdentity: string;
}

export interface CanonicalWebglUploadSession {
	id: string;
	projectId: number;
	kind: 'WEBGL';
	state: 'VERIFYING';
	generation: number;
	totalBytes: bigint;
	bucket: string;
	objectKey: string;
	sourceIdentityAlgorithm: string;
	sourceIdentity: string;
	sourceIdentityBlockSizeBytes: number;
	sourceIdentityBlockManifest: unknown;
	resultAssetId: number;
	resultRepresentationId: string;
	reservedWebglDeploymentId: string | null;
	sourceRepresentation: CanonicalWebglSourceRepresentation;
}

export interface ReservedWebglDeployment {
	id: string;
	projectId: number;
	publicBucket: string;
	publicPrefix: string;
	entryObjectKey: string;
	state: 'PENDING' | 'PROCESSING' | 'READY';
	expectedCurrentDeploymentId: string | null;
}

export interface WebglPublishedObjectManifestEntry {
	objectKey: string;
	sizeBytes: string;
	mimeType: string;
	contentEncoding: string | null;
	etag: string | null;
	checksumSha256: string | null;
}

export interface WebglPublishedObjectManifest {
	version: 1;
	objects: WebglPublishedObjectManifestEntry[];
}

export function assertWebglPublishedObjectManifest(
	manifest: WebglPublishedObjectManifest,
	publicPrefix: string,
	entryObjectKey: string,
): void {
	if (manifest.version !== 1 || manifest.objects.length === 0) {
		throw new Error('WebGL published object manifest is empty or unsupported');
	}
	const keys = new Set<string>();
	for (const object of manifest.objects) {
		if (!object.objectKey.startsWith(publicPrefix) || object.objectKey === publicPrefix
			|| keys.has(object.objectKey) || !/^\d+$/.test(object.sizeBytes)
			|| BigInt(object.sizeBytes) < 0n || !object.mimeType
			|| !(object.contentEncoding === null || object.contentEncoding === 'br' || object.contentEncoding === 'gzip')
			|| !(object.etag === null || typeof object.etag === 'string')
			|| !(object.checksumSha256 === null || /^[a-f0-9]{64}$/i.test(object.checksumSha256))
			|| (object.etag === null && object.checksumSha256 === null)) {
			throw new Error('WebGL published object manifest is malformed');
		}
		keys.add(object.objectKey);
	}
	if (!keys.has(entryObjectKey)) throw new Error('WebGL published object manifest omits index.html');
}

export interface WebglProcessingRepository {
	/** Transactionally create-or-return the one durable generation for this session. */
	reserveDeployment(input: {
		sessionId: string;
		generation: number;
		claimToken: string;
		candidateDeploymentId: string;
		publicBucket: string;
		publicPrefix: string;
		entryObjectKey: string;
		sourceRepresentationId: string;
	}): Promise<ReservedWebglDeployment>;
	/**
	 * One transaction performs every READY transition and a CAS from the
	 * reservation's captured current pointer. It also durably schedules cleanup
	 * for a superseded public generation when policy allows deletion.
	 */
	commitReady(input: {
		sessionId: string;
		generation: number;
		claimToken: string;
		deploymentId: string;
		expectedCurrentDeploymentId: string | null;
		assetId: number;
		representationId: string;
		representationUpdatedAt: Date;
		objectManifest: WebglPublishedObjectManifest;
	}): Promise<'COMMITTED' | 'ALREADY_READY' | 'FENCED'>;
	/** Atomically terminalize the fenced session and enqueue exact-prefix cleanup. */
	rejectFencedAndQueueCleanup(input: {
		sessionId: string;
		generation: number;
		claimToken: string;
		publicBucket: string;
		publicPrefix: string;
		reason: string;
	}): Promise<void>;
}

export interface WebglProcessingContext {
	claimToken: string;
	signal: AbortSignal;
	assertClaimOwned(): Promise<void>;
}

export class WebglTerminalValidationError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'WebglTerminalValidationError';
	}
}

export class WebglGenerationFencedError extends Error {
	constructor() {
		super('WebGL deployment lost the project pointer compare-and-swap');
		this.name = 'WebglGenerationFencedError';
	}
}

export interface WebglTempDiskBudget {
	tryReserve(bytes: number): (() => void) | null;
}

function manifestBytes(value: unknown): Buffer {
	if (typeof value === 'string') {
		try { return decodePersistedSourceIdentityManifest(value); }
		catch (cause) { throw new WebglTerminalValidationError('WebGL source identity manifest is malformed', { cause }); }
	}
	const digests = Array.isArray(value)
		? value
		: value && typeof value === 'object' && Array.isArray((value as { digests?: unknown }).digests)
			? (value as { digests: unknown[] }).digests
			: null;
	if (!digests || digests.some((digest) => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) {
		throw new WebglTerminalValidationError('WebGL source identity manifest is malformed');
	}
	return Buffer.concat(digests.map((digest) => Buffer.from(digest as string, 'hex')));
}

function terminalValidationError(error: unknown): WebglTerminalValidationError | null {
	if (error instanceof WebglTerminalValidationError) return error;
	if (error instanceof ZipValidationError
		|| (error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500)) {
		return new WebglTerminalValidationError(error.message, { cause: error });
	}
	return null;
}

function assertCanonicalSource(session: CanonicalWebglUploadSession): void {
	const source = session.sourceRepresentation;
	if (session.kind !== 'WEBGL' || session.state !== 'VERIFYING'
		|| source.role !== 'WEBGL_SOURCE' || source.state !== 'VERIFYING'
		|| source.id !== session.resultRepresentationId
		|| source.assetId !== session.resultAssetId
		|| source.bucket !== session.bucket || source.objectKey !== session.objectKey
		|| source.sizeBytes !== session.totalBytes
		|| source.sourceIdentityAlgorithm !== session.sourceIdentityAlgorithm
		|| source.sourceIdentity !== session.sourceIdentity) {
		throw new WebglTerminalValidationError('VERIFYING session has no matching proven WEBGL_SOURCE representation');
	}
}

export function createWebglProcessingProcessor(deps: {
	publicBucket: string;
	tempRoot: string;
	physicalArchiveByteLimit: number;
	diskBudget: WebglTempDiskBudget;
	repository: WebglProcessingRepository;
	storage: {
		openSource(input: { bucket: string; objectKey: string; signal: AbortSignal }): Promise<{
			body: Readable;
			sizeBytes: number;
		}>;
	};
	uploader: WebglPublicObjectUploader & {
		head(input: { bucket: string; objectKey: string; signal: AbortSignal }): Promise<{
			sizeBytes: number;
			mimeType: string;
			etag: string | null;
			checksumSha256: string | null;
		} | null>;
	};
	ids: { next(): string };
	logger: { warn(context: Record<string, unknown>, message: string): void };
	zipPolicy?: Omit<BoundedZipValidationOptions, 'profile' | 'signal' | 'maxArchiveBytes'>;
}) {
	const tempRoot = resolve(deps.tempRoot);
	if (!Number.isSafeInteger(deps.physicalArchiveByteLimit) || deps.physicalArchiveByteLimit < 1) {
		throw new RangeError('WebGL physical archive byte limit must be a positive safe integer');
	}

	return {
		async process(
			session: CanonicalWebglUploadSession,
			context: WebglProcessingContext,
		): Promise<{ deploymentId: string; publicPrefix: string; entryObjectKey: string }> {
			assertCanonicalSource(session);
			const totalBytes = Number(session.totalBytes);
			if (!Number.isSafeInteger(totalBytes) || totalBytes < 1
				|| totalBytes > deps.physicalArchiveByteLimit) {
				throw new WebglTerminalValidationError('WebGL source exceeds the physical archive byte limit');
			}
			const releaseDisk = deps.diskBudget.tryReserve(totalBytes);
			if (!releaseDisk) throw new Error('WebGL processing temp disk budget is exhausted');
			let directory: string | undefined;
			try {
				await mkdir(tempRoot, { recursive: true, mode: 0o700 });
				directory = await mkdtemp(join(tempRoot, 'pcu-webgl-processing-'));
				const archivePath = join(directory, 'source.zip');
				await context.assertClaimOwned();
				const source = await deps.storage.openSource({
					bucket: session.bucket,
					objectKey: session.objectKey,
					signal: context.signal,
				});
				if (source.sizeBytes !== totalBytes) {
					throw new WebglTerminalValidationError('WebGL protected source size does not match its representation');
				}
				try {
					await materializeAndValidateCompletedSource({
						totalBytes: session.totalBytes,
						sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
						sourceIdentity: session.sourceIdentity,
						sourceIdentityBlockSizeBytes: session.sourceIdentityBlockSizeBytes,
						sourceIdentityBlockManifest: manifestBytes(session.sourceIdentityBlockManifest),
						source: source.body,
						destination: createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }),
						physicalByteLimit: deps.physicalArchiveByteLimit,
						signal: context.signal,
					});
				} catch (error) {
					throw terminalValidationError(error) ?? error;
				}
				await context.assertClaimOwned();

				let layout;
				try {
					const summary = await validateBoundedZipFile(archivePath, {
						profile: 'WEBGL',
						signal: context.signal,
						maxArchiveBytes: deps.physicalArchiveByteLimit,
						...deps.zipPolicy,
					});
					layout = analyzeWebglArchive(summary);
				} catch (error) {
					throw terminalValidationError(error) ?? error;
				}
				await context.assertClaimOwned();

				const candidateDeploymentId = deps.ids.next();
				const candidateKeys = createCanonicalWebglPublicKeys(session.projectId, candidateDeploymentId);
				const reservation = await deps.repository.reserveDeployment({
					sessionId: session.id,
					generation: session.generation,
					claimToken: context.claimToken,
					candidateDeploymentId,
					publicBucket: deps.publicBucket,
					publicPrefix: candidateKeys.publicPrefix,
					entryObjectKey: candidateKeys.entryObjectKey,
					sourceRepresentationId: session.sourceRepresentation.id,
				});
				const keys = createCanonicalWebglPublicKeys(session.projectId, reservation.id);
				if (reservation.projectId !== session.projectId
					|| reservation.publicBucket !== deps.publicBucket
					|| reservation.publicPrefix !== keys.publicPrefix
					|| reservation.entryObjectKey !== keys.entryObjectKey) {
					throw new Error('Persisted WebGL deployment identity is malformed');
				}
				if (reservation.state !== 'READY') {
					const publishedObjectKeys = await uploadWebglArchive({
						archivePath,
						publicBucket: deps.publicBucket,
						publicPrefix: keys.publicPrefix,
						layout,
						uploader: deps.uploader,
						signal: context.signal,
					});
					if (!publishedObjectKeys.includes(keys.entryObjectKey)) {
						throw new Error('Validated WebGL publish omitted index.html');
					}
					const objects: WebglPublishedObjectManifestEntry[] = [];
					for (const objectKey of [...publishedObjectKeys].sort()) {
						const head = await deps.uploader.head({
							bucket: deps.publicBucket,
							objectKey,
							signal: context.signal,
						});
						if (!head || !Number.isSafeInteger(head.sizeBytes) || head.sizeBytes < 0) {
							throw new Error('Published WebGL object is unavailable for manifest recovery');
						}
						const relativePath = objectKey.slice(keys.publicPrefix.length);
						const expected = webglContentMetadata(relativePath);
						if (head.mimeType.split(';', 1)[0]!.trim().toLowerCase()
							!== expected.contentType.split(';', 1)[0]!.trim().toLowerCase()) {
							throw new Error('Published WebGL object MIME changed during manifest recovery');
						}
						objects.push({
							objectKey,
							sizeBytes: String(head.sizeBytes),
							mimeType: head.mimeType,
							contentEncoding: expected.contentEncoding ?? null,
							etag: head.etag,
							checksumSha256: head.checksumSha256,
						});
					}
					const objectManifest: WebglPublishedObjectManifest = { version: 1, objects };
					assertWebglPublishedObjectManifest(objectManifest, keys.publicPrefix, keys.entryObjectKey);
					await context.assertClaimOwned();
					const committed = await deps.repository.commitReady({
						sessionId: session.id,
						generation: session.generation,
						claimToken: context.claimToken,
						deploymentId: reservation.id,
						expectedCurrentDeploymentId: reservation.expectedCurrentDeploymentId,
						assetId: session.sourceRepresentation.assetId,
						representationId: session.sourceRepresentation.id,
						representationUpdatedAt: session.sourceRepresentation.updatedAt,
						objectManifest,
					});
					if (committed === 'FENCED') {
						await deps.repository.rejectFencedAndQueueCleanup({
							sessionId: session.id,
							generation: session.generation,
							claimToken: context.claimToken,
							publicBucket: deps.publicBucket,
							publicPrefix: keys.publicPrefix,
							reason: 'webgl-current-pointer-fenced',
						});
						throw new WebglGenerationFencedError();
					}
				}
				return {
					deploymentId: reservation.id,
					publicPrefix: keys.publicPrefix,
					entryObjectKey: keys.entryObjectKey,
				};
			} finally {
				if (directory) {
					await rm(directory, { recursive: true, force: true }).catch((error) => {
						deps.logger.warn({ error, sessionId: session.id }, 'Failed to remove WebGL worker temp directory');
					});
				}
				releaseDisk();
			}
		},
	};
}
