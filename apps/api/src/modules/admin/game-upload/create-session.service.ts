import type { GameUploadSession, UserRole } from '@pcu/contracts';
import type { UploadKind } from '@pcu/contracts';
import { AppError, badRequest, conflict } from '../../../shared/errors.js';
import { assertValidUploadFilename } from '../../../shared/filename-validation.js';
import { assertUploadAllowed } from '../upload-guard.js';
import { resolveChunkSizeBytes } from './session-sizing.js';
import {
	ActiveUploadCompletionInProgressError,
	type GameUploadServiceDependencies,
} from './ports.js';
import {
	aggregateBusinessAndCleanupError,
	cleanupUntrackedMultipart,
	UntrackedMultipartCleanupError,
} from './multipart-cleanup.js';

/** Create a new chunked upload session for a project */
export async function createSession(
	deps: GameUploadServiceDependencies,
	projectId: number,
	exhibitionId: number,
	user: { id: number; role: UserRole },
	body: { originalName?: string; totalBytes?: number; uploadKind?: UploadKind },
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
			s3UploadId,
			s3Key,
			expiresAt,
		});
	} catch (err) {
		const businessError = err instanceof ActiveUploadCompletionInProgressError
			? conflict(err.message)
			: err;
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
				{ err, sessionId: abort.sessionId, s3Key: abort.key, tracking: abort.tracking },
				'Failed to abort multipart upload while replacing active session',
			);
		});
	}

	return {
		sessionId: created.session.id,
		chunkSizeBytes,
		totalChunks,
		expiresAt: expiresAt.toISOString(),
		uploadKind,
	};
}
