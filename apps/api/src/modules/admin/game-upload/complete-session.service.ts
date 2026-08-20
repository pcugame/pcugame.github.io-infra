import type {
	GameUploadCompletionResponse,
	GameUploadCompleteRequest,
	UserRole,
} from '@pcu/contracts';
import { AppError, badRequest, conflict, operationInProgress } from '../../../shared/errors.js';
import { loadSession } from './session-loader.js';
import { assertSessionHasSourceIdentity } from './source-identity.js';
import { assertUploadStateTransition } from './state-machine.js';
import type {
	GameUploadServiceDependencies,
	GameUploadSessionRecord,
} from './ports.js';
import { createCompletionClaimGuard } from './completion-claim.js';
import {
	crossCheckSubmittedAndStoredParts,
	validateStoredParts,
	validateSubmittedCompletionParts,
} from './direct-multipart.js';
import { recordGameUploadEvent, safeGameUploadLogContext } from './observability.js';

function resultCount(result: unknown): number | undefined {
	return typeof result === 'object'
		&& result !== null
		&& 'count' in result
		&& typeof result.count === 'number'
		? result.count
		: undefined;
}

function signalRequest(signal?: AbortSignal): [] | [{ signal: AbortSignal }] {
	return signal ? [{ signal }] : [];
}

async function completeMultipartSession(
	deps: GameUploadServiceDependencies,
	session: GameUploadSessionRecord,
	body: GameUploadCompleteRequest,
): Promise<GameUploadCompletionResponse> {
	assertSessionHasSourceIdentity(session);
	const generation = session.multipartGeneration ?? 1;
	if (body.generation !== generation) {
		recordGameUploadEvent(deps, 'stale_generation_rejected', {
			projectId: session.projectId,
			sessionId: session.id,
			generation: body.generation,
			result: 'rejected',
		});
		throw conflict('Upload generation is stale');
	}
	if (session.status === 'VERIFYING') {
		return {
			status: 'VERIFYING',
			sessionId: session.id,
			generation,
			sizeBytes: Number(session.totalBytes),
		};
	}
	if (session.status === 'COMPLETING') {
		throw operationInProgress('Upload completion is already in progress');
	}
	if (session.status !== 'PENDING') {
		throw badRequest(`Cannot complete: session is ${session.status}`);
	}
	if (!await deps.repository.isSessionActive(session.id)) {
		throw conflict('Upload session has been replaced');
	}
	if (!session.s3UploadId || !session.s3Key) {
		throw new AppError(500, 'Session is missing S3 multipart info', 'INTERNAL_ERROR');
	}
	const submitted = validateSubmittedCompletionParts(body.parts, session.totalChunks);
	assertUploadStateTransition(session.status, 'COMPLETING');

	const completionToken = deps.ids.next();
	const transitioned = await deps.repository.claimCompletion({
		sessionId: session.id,
		generation,
		token: completionToken,
		leaseMs: 2 * 60 * 1000,
	});
	if (transitioned.count === 0) {
		throw conflict('Session changed before completion could be claimed');
	}

	let storageCompleted = false;
	let completionStateResolved = false;
	const storageKey = session.s3Key;
	const completionClaim = createCompletionClaimGuard({
		sessionId: session.id,
		token: completionToken,
		renew: deps.repository.renewCompletionClaim,
		logHeartbeatFailure: (error) => deps.logger.error(
			safeGameUploadLogContext({ error, sessionId: session.id, action: 'claim_heartbeat', result: 'failed' }),
			'Completion claim heartbeat failed',
		),
	});
	const storageRequest = { signal: completionClaim.signal };
	try {
		await completionClaim.assertOwned();
		const listed = await deps.storage.listParts(
			session.s3Key,
			session.s3UploadId,
			...signalRequest(storageRequest.signal),
		);
		await completionClaim.assertOwned();
		const stored = validateStoredParts({
			parts: listed,
			totalBytes: session.totalBytes,
			chunkSizeBytes: session.chunkSizeBytes,
			totalChunks: session.totalChunks,
			requireComplete: true,
		});
		crossCheckSubmittedAndStoredParts(submitted, stored);

		// Complete is built only from the authoritative Garage ListParts result.
		await deps.storage.completeMultipart(
			session.s3Key,
			session.s3UploadId,
			stored.map(({ partNumber, etag }) => ({ partNumber, etag })),
			...signalRequest(storageRequest.signal),
		);
		storageCompleted = true;
		await completionClaim.assertOwned();
		const head = await deps.storage.head(storageKey, ...signalRequest(storageRequest.signal));
		if (!head) {
			throw new AppError(500, 'Completed object not found in S3', 'INTERNAL_ERROR');
		}
		await completionClaim.assertOwned();
		recordGameUploadEvent(deps, 'upload_session_completed_storage', {
			projectId: session.projectId,
			sessionId: session.id,
			generation,
			declaredBytes: Number(session.totalBytes),
			verifiedBytes: head.size,
			result: 'completed',
		});
		const verifying = await deps.repository.markVerifying({
			sessionId: session.id,
			generation,
			storageKey,
			verifiedSizeBytes: head.size,
			completionClaimToken: completionToken,
		});
		if (verifying.count !== 1) throw completionClaim.loseClaim();
		completionStateResolved = true;
		recordGameUploadEvent(deps, 'upload_session_verifying', {
			projectId: session.projectId,
			sessionId: session.id,
			generation,
			result: 'queued',
		});
		completionClaim.stop();
		return {
			status: 'VERIFYING',
			sessionId: session.id,
			generation,
			sizeBytes: head.size,
		};
	} catch (error) {
		if (completionStateResolved) throw error;
		if (completionClaim.isLost()) {
			deps.logger.warn(
				safeGameUploadLogContext({ error, sessionId: session.id, action: 'complete', result: 'claim_lost' }),
				'Completion claim was lost; preserving current state',
			);
			throw error;
		}
		if (!storageCompleted) {
			try {
				storageCompleted = await deps.storage.head(
					storageKey,
					...signalRequest(storageRequest.signal),
				) !== null;
			} catch (inspectionError) {
				deps.logger.error(
					safeGameUploadLogContext({ error: inspectionError, sessionId: session.id, action: 'head_completed_object', result: 'ambiguous' }),
					'Multipart completion outcome is ambiguous; preserving COMPLETING',
				);
				throw error;
			}
			if (!storageCompleted) {
				try {
					await deps.storage.listParts(
						session.s3Key,
						session.s3UploadId,
						...signalRequest(storageRequest.signal),
					);
				} catch (inspectionError) {
					deps.logger.error(
						safeGameUploadLogContext({ error: inspectionError, sessionId: session.id, action: 'list_parts_recovery', result: 'ambiguous' }),
						'Multipart object and upload state are ambiguous; preserving COMPLETING',
					);
					throw error;
				}
			}
		}
		if (!storageCompleted) {
			assertUploadStateTransition('COMPLETING', 'PENDING');
			await completionClaim.assertOwned();
			const reverted = await deps.repository.revertToPending(session.id, completionToken);
			if (resultCount(reverted) !== 1) throw completionClaim.loseClaim();
			completionStateResolved = true;
		}
		throw error;
	} finally {
		completionClaim.stop();
		if (!completionStateResolved) {
			try {
				await deps.repository.releaseCompletionClaim(
					session.id,
					completionToken,
					'completion-deferred',
				);
			} catch (releaseError) {
				deps.logger.error(
					safeGameUploadLogContext({ error: releaseError, sessionId: session.id, action: 'release_claim', result: 'failed' }),
					'Failed to release deferred completion claim',
				);
			}
		}
	}
}

/** Complete the browser-to-Garage multipart upload and queue verification. */
export async function completeSession(
	deps: GameUploadServiceDependencies,
	sessionId: string,
	user: { id: number; role: UserRole },
	body: GameUploadCompleteRequest,
): Promise<GameUploadCompletionResponse> {
	const session = await loadSession(deps, sessionId, user.id, user.role);
	const generation = session.multipartGeneration ?? 1;
	if (body.generation !== generation) {
		recordGameUploadEvent(deps, 'stale_generation_rejected', {
			projectId: session.projectId,
			sessionId: session.id,
			generation: body.generation,
			result: 'rejected',
		});
		throw conflict('Upload generation is stale');
	}
	if (session.status === 'COMPLETED') {
		if (session.completionResult && typeof session.completionResult === 'object') {
			return session.completionResult as GameUploadCompletionResponse;
		}
		throw new AppError(500, 'Completed session is missing its domain result', 'INTERNAL_ERROR');
	}
	return completeMultipartSession(deps, session, body);
}
