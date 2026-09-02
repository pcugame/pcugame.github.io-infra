export type ImageRejectionCode =
	| 'SOURCE_IDENTITY_INVALID'
	| 'MAGIC_INVALID'
	| 'RASTER_INVALID'
	| 'PDF_INVALID'
	| 'PDF_TIMEOUT'
	| 'DIMENSION_LIMIT'
	| 'PIXEL_LIMIT'
	| 'ANIMATION_UNSUPPORTED'
	| 'MULTIPAGE_UNSUPPORTED'
	| 'RESOURCE_LIMIT';

export class ImageRejectedError extends Error {
	readonly code: ImageRejectionCode;
	constructor(message: string, code: ImageRejectionCode, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ImageRejectedError';
		this.code = code;
	}
}

export class ImageInfrastructureError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ImageInfrastructureError';
	}
}

export function imageErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
