import { safeLogError } from '../../../shared/safe-log-context.js';

export type GameUploadLifecycleEvent =
	| 'upload_session_created'
	| 'upload_part_urls_issued'
	| 'upload_part_url_refreshed'
	| 'quota_rejected'
	| 'stale_generation_rejected'
	| 'oversized_part_rejected'
	| 'replacement_fenced'
	| 'upload_session_completed_storage'
	| 'upload_session_verifying'
	| 'upload_session_ready'
	| 'upload_session_rejected'
	| 'upload_session_expired'
	| 'upload_session_cancelled'
	| 'verification_started'
	| 'verification_bytes_read'
	| 'verification_duration'
	| 'validation_retry'
	| 'public_origin_health'
	| 'cleanup_task_backlog'
	| 'untracked_multipart'
	| 'worker_queue_lag'
	| 'worker_active_count'
	| 'worker_temp_disk_usage';

const SAFE_CONTEXT_FIELDS = new Set([
	'actorId', 'projectId', 'sessionId', 'assetId', 'generation', 'uploadKind',
	'action', 'result', 'quota', 'partCount', 'declaredBytes', 'verifiedBytes',
	'bytesRead', 'durationMs', 'queueLagMs', 'queueDepth', 'activeCount',
	'tempBytes', 'cleanupBacklog', 'untrackedCount', 'status',
]);

/**
 * Error paths use the same narrow field boundary as lifecycle events. Error
 * messages are intentionally excluded because storage SDK errors can embed a
 * signed URL, raw upload ID, bucket key, or query string.
 */
export function safeGameUploadLogContext(
	context: Record<string, unknown>,
): Record<string, unknown> {
	const safeContext = Object.fromEntries(Object.entries(context)
		.filter(([key]) => SAFE_CONTEXT_FIELDS.has(key)));
	if ('error' in context) safeContext.error = safeLogError(context.error);
	if ('err' in context) safeContext.err = safeLogError(context.err);
	return safeContext;
}

export function recordGameUploadEvent(
	deps: { logger: { info?(context: Record<string, unknown>, message: string): void } },
	event: GameUploadLifecycleEvent,
	context: Record<string, unknown>,
): void {
	const safeContext = safeGameUploadLogContext(context);
	deps.logger.info?.(
		{ action: event, ...safeContext },
		event,
	);
}
