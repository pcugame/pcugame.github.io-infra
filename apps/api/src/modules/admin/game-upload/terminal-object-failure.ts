import type { GameUploadServiceDependencies } from './ports.js';

/**
 * Resolve a deterministically invalid object produced by CompleteMultipartUpload.
 * The repository commits FAILED + outbox atomically before the worker wake.
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
	const committed = await deps.repository.markCompletedObjectFailed(input);
	if (committed.count !== 1) {
		throw new Error('Completion claim was lost before terminal failure could commit');
	}
	deps.wakeDeletionWorker();
}
