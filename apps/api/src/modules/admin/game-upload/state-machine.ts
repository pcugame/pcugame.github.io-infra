import { badRequest } from '../../../shared/errors.js';

export type UploadSessionState =
	| 'PENDING'
	| 'COMPLETING'
	| 'COMPLETED'
	| 'FAILED'
	| 'CANCELLED';

const ALLOWED_TRANSITIONS: Record<UploadSessionState, readonly UploadSessionState[]> = {
	PENDING: ['COMPLETING', 'CANCELLED', 'FAILED'],
	// PENDING is the retry path used only when multipart completion demonstrably
	// did not create the final object.
	COMPLETING: ['PENDING', 'COMPLETED', 'FAILED'],
	COMPLETED: [],
	FAILED: [],
	CANCELLED: [],
};

export function isUploadSessionState(value: string): value is UploadSessionState {
	return Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, value);
}

export function assertUploadStateTransition(
	current: string,
	next: UploadSessionState,
): void {
	if (!isUploadSessionState(current) || !ALLOWED_TRANSITIONS[current].includes(next)) {
		throw badRequest(`Cannot transition upload session from ${current} to ${next}`);
	}
}
