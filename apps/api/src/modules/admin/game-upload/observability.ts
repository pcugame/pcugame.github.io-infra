export type GameUploadLifecycleEvent =
	| 'upload_session_created'
	| 'direct_transport_selected'
	| 'legacy_proxy_transport_selected'
	| 'upload_part_urls_issued'
	| 'upload_session_completed_storage'
	| 'upload_session_verifying'
	| 'upload_session_ready'
	| 'upload_session_rejected'
	| 'upload_session_expired'
	| 'validation_retry';

export function recordGameUploadEvent(
	deps: { logger: { info?(context: Record<string, unknown>, message: string): void } },
	event: GameUploadLifecycleEvent,
	context: Record<string, unknown>,
): void {
	deps.logger.info?.(
		{ action: event, ...context },
		event,
	);
}
