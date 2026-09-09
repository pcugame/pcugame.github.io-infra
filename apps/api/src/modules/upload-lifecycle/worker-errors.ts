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
