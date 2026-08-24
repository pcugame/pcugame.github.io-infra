import type {
	DirectGameUploadCompleteRequest,
	DirectGameUploadCreateSessionRequest,
	DirectGameUploadPartUrlsRequest,
	DirectGameUploadPartUrlsResponse,
	DirectUploadSourceIdentity,
} from '@pcu/contracts';
import { DIRECT_UPLOAD_PART_CAPABILITY_BATCH_MAX } from '@pcu/contracts';
import { AppError, badRequest, conflict, operationInProgress } from '../../shared/errors.js';
import { assertValidUploadFilename } from '../../shared/filename-validation.js';
import { createClaimHeartbeatGuard } from '../upload-lifecycle/claim-heartbeat.js';
import { assertMultipartPartCount, assertCompletionManifestMatchesGarage, validateStoredMultipartParts, validateSubmittedCompletionParts } from '../admin/game-upload/direct-multipart.js';
import {
	encodePersistedSourceIdentityManifest,
	validateSourceIdentity,
} from '../admin/game-upload/source-identity.js';
import type { AssetUploadSessionRecord, AssetUploadRepository, DirectAssetUploadKind, DirectAssetUploadOwner, DirectMultipartControlStorage, DirectPartSigner } from './ports.js';

const COMPLETION_LEASE_MS = 120_000;
type DirectCreateBody = DirectGameUploadCreateSessionRequest;

function verifyingCompletionResult(
	sessionId: string,
	generation: number,
	sizeBytes: number,
	etag?: string,
) {
	// Garage ETags are opaque provenance. Preserve weak and multipart forms;
	// trimming transport whitespace is the only normalization performed.
	const normalizedEtag = etag?.trim();
	return {
		status: 'VERIFYING' as const,
		sessionId,
		generation,
		sizeBytes,
		...(normalizedEtag ? { etag: normalizedEtag } : {}),
	};
}

function sessionResult(session: AssetUploadSessionRecord, parts: Awaited<ReturnType<DirectMultipartControlStorage['listParts']>>) {
	const owner: DirectAssetUploadOwner = session.projectId !== null
		? { type: 'PROJECT', id: session.projectId }
		: { type: 'EXHIBITION', id: session.exhibitionId! };
	return {
		sessionId: session.id,
		...(session.projectId !== null ? { projectId: session.projectId } : {}),
		...(session.exhibitionId !== null ? { exhibitionId: session.exhibitionId } : {}),
		owner,
		kind: session.kind,
		state: session.state,
		generation: session.generation,
		originalName: session.originalName,
		totalBytes: Number(session.totalBytes),
		partSizeBytes: session.partSizeBytes,
		totalParts: session.totalParts,
		expiresAt: session.expiresAt.toISOString(),
		sourceIdentityAlgorithm: session.sourceIdentityAlgorithm,
		sourceIdentity: session.sourceIdentity,
		parts,
	};
}

function sourceExtension(kind: DirectAssetUploadKind): string {
	if (kind === 'GAME' || kind === 'WEBGL') return 'zip';
	return 'bin';
}

export function createAssetUploadService(deps: {
	repository: AssetUploadRepository;
	storage: DirectMultipartControlStorage;
	partSigner: DirectPartSigner;
	clock: { now(): Date };
	ids: { next(): string };
	config: {
		bucket: string;
		sessionTtlMs: number;
		partSizeBytes: number;
		partUrlTtlSeconds: number;
		/** Extra session-lifetime capabilities allowed after the first totalParts. */
		partUrlRefreshMax: number;
		maxBytesFor(actor: { id: number; role: string }, kind: DirectAssetUploadKind): number;
	};
	authorizeProjectWrite(actor: { id: number; role: string }, projectId: number): Promise<{ exhibitionId: number; status: string }>;
	authorizeExhibitionWrite?(actor: { id: number; role: string }, exhibitionId: number): Promise<void>;
}) {
	async function authorizeOwnerWrite(actor: { id: number; role: string }, owner: DirectAssetUploadOwner): Promise<void> {
		if (owner.type === 'PROJECT') {
			await deps.authorizeProjectWrite(actor, owner.id);
			return;
		}
		if (!deps.authorizeExhibitionWrite) throw badRequest('Exhibition direct upload is not enabled');
		await deps.authorizeExhibitionWrite(actor, owner.id);
	}
	function ownerForSession(session: AssetUploadSessionRecord): DirectAssetUploadOwner {
		if (session.projectId !== null) return { type: 'PROJECT', id: session.projectId };
		if (session.exhibitionId !== null) return { type: 'EXHIBITION', id: session.exhibitionId };
		throw new Error('Upload session has no domain owner');
	}
	async function loadOwned(sessionId: string, actor: { id: number; role: string }): Promise<AssetUploadSessionRecord> {
		const session = await deps.repository.findById(sessionId);
		if (!session) throw badRequest('Upload session not found');
		await authorizeOwnerWrite(actor, ownerForSession(session));
		return session;
	}
	async function resolveDurableCompletionOutcome(
		sessionId: string,
		generation: number,
		fallbackSize: number,
	) {
		const durable = await deps.repository.findById(sessionId);
		if (!durable || durable.generation !== generation) {
			throw conflict('Upload completion lease was lost');
		}
		if (!['VERIFYING', 'READY', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(durable.state)) {
			throw conflict('Upload completion lease was lost');
		}
		return {
			status: durable.state,
			sessionId: durable.id,
			generation: durable.generation,
			sizeBytes: Number.isSafeInteger(Number(durable.totalBytes))
				? Number(durable.totalBytes)
				: fallbackSize,
		};
	}
	async function createSession(
		kind: DirectAssetUploadKind,
		actor: { id: number; role: string },
		owner: DirectAssetUploadOwner,
		body: DirectCreateBody,
	) {
		await authorizeOwnerWrite(actor, owner);
		await deps.repository.expireStaleAllocations(owner);
		const maxBytes = deps.config.maxBytesFor(actor, kind);
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error(`Direct ${kind} upload policy is invalid`);
		if (!Number.isSafeInteger(body.totalBytes) || body.totalBytes < 1 || body.totalBytes > maxBytes) throw badRequest(`Invalid ${kind} upload size`);
		assertValidUploadFilename(body.originalName);
		const identity = validateSourceIdentity(body, body.totalBytes);
		const totalParts = Math.ceil(body.totalBytes / deps.config.partSizeBytes);
		assertMultipartPartCount(totalParts);
		const id = deps.ids.next();
		let session: AssetUploadSessionRecord;
		try {
			session = await deps.repository.createAllocating({
			id,
			projectId: owner.type === 'PROJECT' ? owner.id : null,
			exhibitionId: owner.type === 'EXHIBITION' ? owner.id : null,
			userId: actor.id, kind, originalName: body.originalName,
			// Browser MIME is advisory.  Workers derive the trusted type from the
			// completed bytes after Garage multipart completion.
			declaredMimeType: body.declaredMimeType?.slice(0, 255) ?? (kind === 'GAME' || kind === 'WEBGL' ? 'application/zip' : ''), totalBytes: BigInt(body.totalBytes),
			partSizeBytes: deps.config.partSizeBytes, totalParts, bucket: deps.config.bucket,
			objectKey: `protected/uploads/${id}/1/source.${sourceExtension(kind)}`, generation: 1,
			sourceIdentityAlgorithm: identity.algorithm, sourceIdentity: identity.identity,
			sourceIdentityBlockSizeBytes: identity.blockSizeBytes,
			sourceIdentityBlockManifest: encodePersistedSourceIdentityManifest(identity.manifest),
			expiresAt: new Date(deps.clock.now().getTime() + deps.config.sessionTtlMs),
			submissionItemId: body.submissionItem?.id ?? null,
			...(body.submissionItem ? { submissionClientToken: body.submissionItem.clientToken } : {}),
			});
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('PROJECT_SUBMISSION_ITEM_')) {
				throw conflict('Direct upload does not match an available project submission item');
			}
			throw error;
		}
		let uploadId: string;
		try {
			uploadId = await deps.storage.createMultipart(session.bucket, session.objectKey, kind === 'GAME' || kind === 'WEBGL' ? 'application/zip' : 'application/octet-stream');
		} catch (error) {
			// CreateMultipart can fail after Garage accepted the request but before a
			// response reached us.  There is no trustworthy upload ID to abort here;
			// close the DB slot now and let age-fenced inventory recovery reap any
			// unknown multipart in this session's closed namespace.
			await deps.repository.failAllocation({
				sessionId: session.id,
				generation: session.generation,
				reason: `CreateMultipart failed: ${String(error instanceof Error ? error.message : error)}`,
			});
			throw new AppError(503, 'Object storage could not allocate upload', 'INTERNAL_ERROR', { cause: error });
		}
		if (!await deps.repository.setAllocated(session.id, session.generation, uploadId)) {
			await deps.repository.queueAbort({ sessionId: session.id, bucket: session.bucket, objectKey: session.objectKey, uploadId, reason: 'allocation-race-loser' });
			throw conflict('Upload allocation was superseded; retry status');
		}
		return {
			sessionId: session.id,
			owner,
			generation: 1,
			partSizeBytes: session.partSizeBytes,
			totalParts,
			expiresAt: session.expiresAt.toISOString(),
			sourceIdentityAlgorithm: identity.algorithm,
			sourceIdentity: identity.identity,
			sourceIdentityBlockSizeBytes: identity.blockSizeBytes,
		};
	}
	return {
		async createGameSession(actor: { id: number; role: string }, projectId: number, body: DirectCreateBody) {
			return createSession('GAME', actor, { type: 'PROJECT', id: projectId }, body);
		},

		async createWebglSession(actor: { id: number; role: string }, projectId: number, body: DirectCreateBody) {
			return createSession('WEBGL', actor, { type: 'PROJECT', id: projectId }, body);
		},

		async createVideoSession(actor: { id: number; role: string }, projectId: number, body: DirectCreateBody) {
			return createSession('VIDEO', actor, { type: 'PROJECT', id: projectId }, body);
		},

		async createImageSession(actor: { id: number; role: string }, projectId: number, body: DirectCreateBody) {
			return createSession('IMAGE', actor, { type: 'PROJECT', id: projectId }, body);
		},

		async createProjectPosterSession(actor: { id: number; role: string }, projectId: number, body: DirectCreateBody) {
			return createSession('POSTER', actor, { type: 'PROJECT', id: projectId }, body);
		},

		async createExhibitionPosterSession(actor: { id: number; role: string }, exhibitionId: number, body: DirectCreateBody) {
			return createSession('POSTER', actor, { type: 'EXHIBITION', id: exhibitionId }, body);
		},

		async signParts(actor: { id: number; role: string }, sessionId: string, body: DirectGameUploadPartUrlsRequest): Promise<DirectGameUploadPartUrlsResponse> {
			if (body.parts.length < 1 || body.parts.length > DIRECT_UPLOAD_PART_CAPABILITY_BATCH_MAX) {
				throw badRequest(`Between 1 and ${DIRECT_UPLOAD_PART_CAPABILITY_BATCH_MAX} parts are required`);
			}
			const session = await loadOwned(sessionId, actor);
			if (!session.uploadId || session.state !== 'UPLOADING') throw conflict('Upload session is not accepting parts');
			if (session.generation !== body.generation) throw conflict('Upload generation is stale');
			const unique = new Set(body.parts.map((part) => part.partNumber));
			if (unique.size !== body.parts.length || body.parts.some((part) => !Number.isSafeInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > session.totalParts || !/^[A-Za-z0-9+/]{43}=$/.test(part.checksumSha256))) throw badRequest('Invalid part capability request');
			let reserved: AssetUploadSessionRecord;
			try {
				reserved = await deps.repository.reservePartCapabilities({
					sessionId,
					actorId: actor.id,
					generation: body.generation,
					partCount: body.parts.length,
					maxRefreshIssues: deps.config.partUrlRefreshMax,
				});
			} catch (error) {
				if (error instanceof Error && error.message === 'DIRECT_UPLOAD_CAPABILITY_QUOTA') {
					throw conflict('Upload part capability refresh budget is exhausted; cancel and restart the session');
				}
				if (error instanceof Error && error.message === 'DIRECT_UPLOAD_CAPABILITY_REJECTED') {
					throw conflict('Upload session is not accepting part capabilities');
				}
				throw error;
			}
			const seconds = Math.max(1, Math.min(deps.config.partUrlTtlSeconds, Math.floor((reserved.expiresAt.getTime() - deps.clock.now().getTime()) / 1000)));
			return { generation: reserved.generation, expiresAt: new Date(deps.clock.now().getTime() + seconds * 1_000).toISOString(), parts: await Promise.all([...body.parts].sort((a, b) => a.partNumber - b.partNumber).map(async (part) => ({ partNumber: part.partNumber, url: await deps.partSigner.presignUploadPart(reserved.bucket, reserved.objectKey, reserved.uploadId!, part.partNumber, seconds, part.checksumSha256), requiredHeaders: { 'content-type': 'application/octet-stream', 'x-amz-checksum-sha256': part.checksumSha256 } }))) };
		},

		async status(actor: { id: number; role: string }, sessionId: string) {
			const session = await loadOwned(sessionId, actor);
			const parts = session.state === 'UPLOADING' && session.uploadId
				? await deps.storage.listParts(session.bucket, session.objectKey, session.uploadId)
				: [];
			return sessionResult(session, parts);
		},

		async cancel(actor: { id: number; role: string }, sessionId: string): Promise<void> {
			const session = await loadOwned(sessionId, actor);
			const cancelled = await deps.repository.cancel(session.id, session.userId);
			if (!cancelled.cancelled) throw conflict('Upload session cannot be cancelled');
		},

		async complete(actor: { id: number; role: string }, sessionId: string, body: DirectGameUploadCompleteRequest) {
			const session = await loadOwned(sessionId, actor);
			if (session.generation !== body.generation) throw conflict('Upload generation is stale');
			if (session.state === 'VERIFYING' || session.state === 'READY') return { status: session.state, sessionId: session.id, generation: session.generation, sizeBytes: Number(session.totalBytes) };
			if (session.state === 'COMPLETING') throw operationInProgress('Upload completion is already in progress');
			if (session.state !== 'UPLOADING' || !session.uploadId) throw conflict('Upload session cannot be completed');
			const submitted = validateSubmittedCompletionParts(body, session.totalParts);
			const stored = validateStoredMultipartParts({ parts: await deps.storage.listParts(session.bucket, session.objectKey, session.uploadId), totalBytes: session.totalBytes, partSizeBytes: session.partSizeBytes, totalParts: session.totalParts });
			assertCompletionManifestMatchesGarage(submitted, stored);
			const token = deps.ids.next();
			const claim = await deps.repository.claimCompletion({ sessionId, actorId: actor.id, generation: body.generation, token, leaseMs: COMPLETION_LEASE_MS });
			if (claim === 'busy') throw operationInProgress('Upload completion is already in progress');
			if (claim !== 'claimed') throw conflict('Upload completion claim is stale');
			const completionLease = createClaimHeartbeatGuard({
				heartbeatMs: 30_000,
				lostMessage: 'Direct upload completion lease was lost',
				renew: () => deps.repository.renewCompletion(sessionId, token, COMPLETION_LEASE_MS).then((owned) => ({ count: owned ? 1 : 0 })),
				logHeartbeatFailure: () => undefined,
			});
			try {
				await completionLease.assertOwned();
				await deps.storage.completeMultipart(session.bucket, session.objectKey, session.uploadId, stored);
				await completionLease.assertOwned();
				const head = await deps.storage.head(session.bucket, session.objectKey);
				if (!head || head.size !== Number(session.totalBytes)) throw new AppError(500, 'Completed object is missing or size-mismatched', 'SIZE_MISMATCH');
				await completionLease.assertOwned();
				const marked = await deps.repository.markVerifying({
					sessionId, token, generation: session.generation, completedSize: head.size,
					result: verifyingCompletionResult(sessionId, session.generation, head.size, head.etag),
				});
				if (!marked) return resolveDurableCompletionOutcome(sessionId, session.generation, head.size);
				return { status: 'VERIFYING' as const, sessionId, generation: session.generation, sizeBytes: head.size };
			} catch (error) {
				if (completionLease.isLost()) throw error;
				// CompleteMultipart is ambiguous on network failure. A HEAD proves success;
				// otherwise keep COMPLETING when storage is unavailable for recovery.
				const head = await deps.storage.head(session.bucket, session.objectKey).catch(() => undefined);
				if (head?.size === Number(session.totalBytes)) {
					const marked = await deps.repository.markVerifying({
						sessionId, token, generation: session.generation, completedSize: head.size,
						result: verifyingCompletionResult(sessionId, session.generation, head.size, head.etag),
					});
					if (!marked) return resolveDurableCompletionOutcome(sessionId, session.generation, head.size);
					return { status: 'VERIFYING' as const, sessionId, generation: session.generation, sizeBytes: head.size };
				}
				if (head === null) await deps.repository.revertUploading(
					sessionId,
					session.generation,
					token,
					String(error),
				);
				throw error;
			} finally {
				completionLease.stop();
			}
		},
	};
}
