import type { GameUploadSession, UserRole } from '@pcu/contracts';
import type { UploadKind } from '@pcu/contracts';
import { AppError, badRequest, conflict } from '../../../shared/errors.js';
import { assertValidUploadFilename } from '../../../shared/filename-validation.js';
import { assertUploadAllowed } from '../upload-guard.js';
import { resolveChunkSizeBytes } from './session-sizing.js';
import { SOURCE_IDENTITY_BLOCK_SIZE_BYTES, validateSourceIdentity } from './source-identity.js';
import {
	ActiveUploadCompletionInProgressError,
	DirectUploadQuotaExceededError,
	type GameUploadServiceDependencies,
} from './ports.js';
import {
	aggregateBusinessAndCleanupError,
	cleanupUntrackedMultipart,
	UntrackedMultipartCleanupError,
} from './multipart-cleanup.js';
import { recordGameUploadEvent, safeGameUploadLogContext } from './observability.js';
import { assertMultipartPartCount } from './direct-multipart.js';

/** Create a new chunked upload session for a project */
export async function createSession(
	deps: GameUploadServiceDependencies,
	projectId: number,
	exhibitionId: number,
	user: { id: number; role: UserRole },
	body: { originalName?: string; totalBytes?: number; uploadKind?: UploadKind; sourceIdentityAlgorithm?: string; sourceIdentity?: string; sourceIdentityBlockSizeBytes?: number; sourceIdentityBlockDigests?: string[] },
): Promise<GameUploadSession> {
	// Refuse to start new multi-chunk sessions once shutdown has begun; in-flight
	// completion calls are still allowed so existing uploads do not get truncated.
	if (!deps.lifecycle.isAcceptingNewWork()) {
		throw new AppError(503, 'Server is restarting; please retry in a moment', 'DRAINING');
	}

	if (!body?.originalName || !body?.totalBytes) {
		throw badRequest('Missing originalName or totalBytes');
	}

	const { originalName, totalBytes } = body;
	const uploadKind = body.uploadKind ?? 'GAME';
	if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
		throw badRequest('totalBytes must be a positive safe integer');
	}
	assertValidUploadFilename(originalName);

	const exhibition = await deps.repository.findExhibitionById(exhibitionId);
	assertUploadAllowed(exhibition, exhibition?.year ?? 0, user.role);

	const settings = await deps.settings.get();
	const maxGameBytes = settings.maxGameFileMb * 1024 * 1024;
	const chunkSizeBytes = resolveChunkSizeBytes(settings, {
		UPLOAD_CHUNK_SIZE_MB: deps.config.uploadChunkSizeMb,
	});

	const effectiveMax = Math.min(maxGameBytes, deps.roleGameMaxBytes(user.role));

	if (totalBytes > effectiveMax) {
		const maxMB = Math.round(effectiveMax / 1024 / 1024);
		throw badRequest(`File size ${Math.round(totalBytes / 1024 / 1024)}MB exceeds max ${maxMB}MB`);
	}

	const totalChunks = Math.ceil(totalBytes / chunkSizeBytes);
	assertMultipartPartCount(totalChunks);
	if (chunkSizeBytes % SOURCE_IDENTITY_BLOCK_SIZE_BYTES !== 0) {
		throw new AppError(500, 'Upload chunk size must align with source identity blocks', 'INTERNAL_ERROR');
	}
	const sourceIdentity = validateSourceIdentity(body, totalBytes);
	try {
		await deps.repository.assertCanCreateSession({
			projectId,
			userId: user.id,
			uploadKind,
			totalBytes: BigInt(totalBytes),
			limits: deps.config.directUploadQuota,
		});
	} catch (err) {
		if (err instanceof DirectUploadQuotaExceededError) {
			recordGameUploadEvent(deps, 'quota_rejected', {
				actorId: user.id,
				projectId,
				uploadKind,
				quota: err.quota,
				result: 'rejected',
			});
			throw new AppError(429, 'Direct upload quota exceeded', 'RATE_LIMITED');
		}
		if (err instanceof ActiveUploadCompletionInProgressError) {
			throw conflict(err.message);
		}
		throw err;
	}
	const s3Key = deps.storageKey(uploadKind, projectId);
	const s3UploadId = await deps.storage.createMultipart(s3Key);
	const expiresAt = new Date(
		deps.clock.now().getTime() + deps.config.uploadSessionTtlMinutes * 60 * 1000,
	);

	let created: Awaited<ReturnType<typeof deps.repository.createSessionReplacingActive>>;
	try {
		created = await deps.repository.createSessionReplacingActive({
			id: deps.ids.next(),
			projectId,
			userId: user.id,
			uploadKind,
			originalName,
			totalBytes: BigInt(totalBytes),
			chunkSizeBytes,
			totalChunks,
			sourceIdentityAlgorithm: sourceIdentity.algorithm,
			sourceIdentity: sourceIdentity.identity,
			sourceIdentityBlockSizeBytes: sourceIdentity.blockSizeBytes,
			sourceIdentityBlockManifest: sourceIdentity.manifest,
			s3UploadId,
			s3Key,
			expiresAt,
		}, deps.config.directUploadQuota);
	} catch (err) {
		const businessError = err instanceof ActiveUploadCompletionInProgressError
			? conflict(err.message)
			: err instanceof DirectUploadQuotaExceededError
				? new AppError(429, 'Direct upload quota exceeded', 'RATE_LIMITED')
				: err;
		if (err instanceof DirectUploadQuotaExceededError) {
			recordGameUploadEvent(deps, 'quota_rejected', {
				actorId: user.id,
				projectId,
				uploadKind,
				quota: err.quota,
				result: 'rejected-after-storage-allocation-race',
			});
		}
		try {
			await cleanupUntrackedMultipart(deps, {
				key: s3Key,
				uploadId: s3UploadId,
				reason: 'session-create-failed',
			});
		} catch (cleanupError) {
			if (cleanupError instanceof UntrackedMultipartCleanupError) {
				throw aggregateBusinessAndCleanupError(
					businessError,
					cleanupError,
					'Session creation and untracked multipart cleanup both failed',
				);
			}
			throw cleanupError;
		}
		throw businessError;
	}

	if (created.durableAborts.length > 0) {
		deps.wakeMaintenance();
	}
	for (const abort of created.durableAborts) {
		// `tracking` is repository evidence that the replacement transaction
		// committed the durable task before this prompt, best-effort abort.
		await deps.storage.abortMultipart(abort.key, abort.uploadId).catch((err) => {
			deps.logger.error(
				safeGameUploadLogContext({ err, sessionId: abort.sessionId, action: 'prompt_abort', result: 'failed' }),
				'Failed to abort multipart upload while replacing active session',
			);
		});
	}
	recordGameUploadEvent(deps, 'upload_session_created', {
		actorId: user.id,
		projectId,
		sessionId: created.session.id,
		generation: 1,
		uploadKind,
		declaredBytes: totalBytes,
		result: 'created',
	});

	return {
		sessionId: created.session.id,
		chunkSizeBytes,
		totalChunks,
		sourceIdentityAlgorithm: sourceIdentity.algorithm,
		sourceIdentity: sourceIdentity.identity,
		sourceIdentityBlockSizeBytes: sourceIdentity.blockSizeBytes,
		expiresAt: expiresAt.toISOString(),
		uploadKind,
		generation: 1,
	};
}
