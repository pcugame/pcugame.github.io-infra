import type { GameUploadServiceDependencies } from './ports.js';

/**
 * Resolve a deterministically invalid object produced by CompleteMultipartUpload.
 * Durable repositories commit FAILED + outbox atomically; legacy test adapters
 * retain the older delete-or-queue fallback.
 */
export async function commitTerminalCompletedObjectFailure(
	deps: GameUploadServiceDependencies,
	input: {
		sessionId: string;
		storageKey: string;
		reason: string;
		completionClaimToken?: string;
	},
): Promise<void> {
	if (!deps.repository.markCompletedObjectFailed) {
		await deps.deleteOrQueue(
			input.storageKey,
			input.reason,
			{ sessionId: input.sessionId },
		);
		await deps.repository.markFailed(input.sessionId, input.storageKey).catch((error) => {
			deps.logger.error(
				{ error, sessionId: input.sessionId },
				'Failed to mark invalid completed upload FAILED',
			);
		});
		return;
	}

	const committed = await deps.repository.markCompletedObjectFailed(input);
	if (committed.count !== 1) {
		throw new Error('Completion claim was lost before terminal failure could commit');
	}
	if (!deps.deleteDurablyQueued) return;
	await deps.deleteDurablyQueued(
		input.storageKey,
		input.reason,
		{ sessionId: input.sessionId },
	).catch((error) => {
		deps.recordPostCommitCleanupFailure?.();
		deps.logger.error(
			{ error, sessionId: input.sessionId, storageKey: input.storageKey },
			'Post-commit invalid upload cleanup failed; durable outbox retained',
		);
	});
}
