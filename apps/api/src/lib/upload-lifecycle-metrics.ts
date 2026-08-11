export interface UploadLifecycleMetrics {
	recordPostCommitCleanupFailure(): void;
	postCommitCleanupFailureCount(): number;
}

/** A deliberately low-cardinality, context-local operational counter. */
export function createUploadLifecycleMetrics(): UploadLifecycleMetrics {
	let postCommitCleanupFailures = 0;
	return {
		recordPostCommitCleanupFailure() {
			postCommitCleanupFailures++;
		},
		postCommitCleanupFailureCount: () => postCommitCleanupFailures,
	};
}
