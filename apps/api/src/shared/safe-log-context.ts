const SAFE_OPERATION_FIELDS = new Set([
	'actorId',
	'projectId',
	'sessionId',
	'assetId',
	'taskId',
	'claimId',
	'generation',
	'action',
	'result',
	'status',
	'attemptCount',
	'claimedCount',
	'requeuedCount',
	'processedCount',
	'resolvedCount',
	'failedCount',
]);

export function safeLogError(error: unknown): { name: string; code?: string } {
	const candidate = error && typeof error === 'object'
		? error as { name?: unknown; code?: unknown }
		: {};
	return {
		name: typeof candidate.name === 'string' ? candidate.name : 'UnknownError',
		...(typeof candidate.code === 'string' ? { code: candidate.code.slice(0, 100) } : {}),
	};
}

/**
 * Narrow structured-log boundary for storage and processing code. Object
 * locators, local paths, reasons and SDK error messages are deliberately not
 * copied: all can contain credentials, signed queries or user-controlled data.
 */
export function safeOperationalLogContext(
	context: Record<string, unknown>,
): Record<string, unknown> {
	const safeContext = Object.fromEntries(Object.entries(context)
		.filter(([key]) => SAFE_OPERATION_FIELDS.has(key)));
	if ('error' in context) safeContext.error = safeLogError(context.error);
	if ('err' in context) safeContext.err = safeLogError(context.err);
	return safeContext;
}
