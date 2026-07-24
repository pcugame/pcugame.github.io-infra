import { badRequest } from '../../../shared/errors.js';
import {
	detectFileType,
	isAllowedPosterType,
	SIZE_LIMITS,
} from '../../../shared/file-signature.js';

/**
 * Validate already-collected POSTER bytes without importing GAME/ZIP storage
 * validation. Header acquisition and file stats remain injected adapter work.
 */
export function validatePosterFile(input: {
	sizeBytes: number;
	header: Buffer;
}): { mimeType: string; ext: string; sizeBytes: number } {
	const fileType = detectFileType(input.header);
	if (!fileType || !isAllowedPosterType(fileType)) {
		throw badRequest('Poster must be JPEG, PNG, WebP, or PDF');
	}
	const limit = fileType.mime === 'application/pdf'
		? SIZE_LIMITS.posterPdf
		: SIZE_LIMITS.poster;
	if (input.sizeBytes > limit) throw badRequest('File too large for kind POSTER');
	return {
		mimeType: fileType.mime,
		ext: fileType.ext,
		sizeBytes: input.sizeBytes,
	};
}
