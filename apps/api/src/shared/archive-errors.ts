export class ZipValidationError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'ZipValidationError';
	}
}

export class ZipValidationAbortedError extends Error {
	constructor(options?: { cause?: unknown }) {
		super('ZIP validation was aborted', options);
		this.name = 'AbortError';
	}
}
