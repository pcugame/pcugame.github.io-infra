import { AppError } from '../../shared/errors.js';

/**
 * A successful, authoritative object-store response proved that the canonical
 * source key does not exist.  This is terminal data loss, not a Garage outage.
 */
export class WorkerSourceObjectMissingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkerSourceObjectMissingError';
	}
}

export function isWorkerSourceObjectMissing(error: unknown): error is WorkerSourceObjectMissingError {
	return error instanceof WorkerSourceObjectMissingError;
}

export class WorkerGenerationFencedError extends Error {
	constructor(kind: string) {
		super(`${kind}_REPLACEMENT_FENCE_LOST`);
		this.name = 'WorkerGenerationFencedError';
	}
}

export const MAX_WORKER_VALIDATION_ATTEMPTS = 5;

export function retryBudgetReason(kind: string, error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `OPERATOR_REQUIRED: ${kind} processing exhausted ${MAX_WORKER_VALIDATION_ATTEMPTS} attempts: ${detail}`
		.slice(0, 500);
}

/** A completed source was read successfully and failed a content invariant. */
export class WorkerInputRejectedError extends AppError {
	constructor(message: string, statusCode = 400, code?: AppError['code']) {
		super(statusCode, message, code);
		this.name = 'WorkerInputRejectedError';
	}
}

/** Persisted metadata or worker configuration cannot safely authorize deletion. */
export class WorkerOperatorRequiredError extends AppError {
	constructor(message: string, statusCode = 500, code?: AppError['code']) {
		super(statusCode, message, code);
		this.name = 'WorkerOperatorRequiredError';
	}
}

export function isWorkerOperationAborted(error: unknown): boolean {
	return error instanceof Error && (error.name === 'AbortError'
		|| ('code' in error && error.code === 'ABORT_ERR'));
}
