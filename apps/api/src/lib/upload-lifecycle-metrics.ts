export interface UploadLifecycleMetrics {
	recordPostCommitCleanupFailure(): void;
	postCommitCleanupFailureCount(): number;
	recordUntrackedMultipartCleanupFailure(): void;
	untrackedMultipartCleanupFailureCount(): number;
}

/** A deliberately low-cardinality, context-local operational counter. */
export function createUploadLifecycleMetrics(): UploadLifecycleMetrics {
	let postCommitCleanupFailures = 0;
	let untrackedMultipartCleanupFailures = 0;
	return {
		recordPostCommitCleanupFailure() {
			postCommitCleanupFailures++;
		},
		postCommitCleanupFailureCount: () => postCommitCleanupFailures,
		recordUntrackedMultipartCleanupFailure() {
			untrackedMultipartCleanupFailures++;
		},
		untrackedMultipartCleanupFailureCount: () => untrackedMultipartCleanupFailures,
	};
}
