export class VideoRejectedError extends Error {
	constructor(
		message: string,
		readonly code:
			| 'MAGIC_INVALID'
			| 'SIZE_INVALID'
			| 'CONTAINER_INVALID'
			| 'CODEC_UNSUPPORTED'
			| 'RESOURCE_LIMIT'
			| 'CORRUPT_MEDIA'
			| 'PROCESS_TIMEOUT'
			| 'PROCESS_OUTPUT_LIMIT',
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'VideoRejectedError';
	}
}

export class VideoInfrastructureError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'VideoInfrastructureError';
	}
}

export function errorMessage(error: unknown): string {
	return String(error instanceof Error ? error.message : error).slice(0, 2_000);
}
