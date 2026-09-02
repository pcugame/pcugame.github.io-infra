import { fileTypeFromBuffer, fileTypeFromFile, type FileTypeResult as DetectedFileType } from 'file-type';

export interface FileTypeResult {
	mime: string;
	ext: string;
}

function normalizeFileType(result: DetectedFileType | undefined): FileTypeResult | null {
	if (!result) return null;

	switch (`${result.ext}:${result.mime}`) {
		case 'jpg:image/jpeg':
		case 'jpeg:image/jpeg':
		case 'png:image/png':
		case 'webp:image/webp':
		case 'pdf:application/pdf':
		case 'zip:application/zip':
			return result;
		case 'mp4:video/mp4':
		case 'mov:video/quicktime':
		case 'm4v:video/x-m4v':
		case '3gp:video/3gpp':
		case '3g2:video/3gpp2':
			return { ext: result.ext, mime: 'video/mp4' };
		case 'mkv:video/matroska':
		case 'webm:video/webm':
			return { ext: result.ext, mime: 'video/x-matroska' };
		case 'avi:video/vnd.avi':
			return { ext: 'avi', mime: 'video/x-msvideo' };
		case 'asf:video/x-ms-asf':
			return { ext: 'wmv', mime: 'video/x-ms-wmv' };
		default:
			return null;
	}
}

export async function detectFileType(buffer: Uint8Array | ArrayBuffer): Promise<FileTypeResult | null> {
	return normalizeFileType(await fileTypeFromBuffer(buffer));
}

export async function detectFileTypeFromFile(
	path: string,
	options?: { signal?: AbortSignal },
): Promise<FileTypeResult | null> {
	return normalizeFileType(await fileTypeFromFile(path, options));
}

const ALLOWED_IMAGE_MIMES = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'application/pdf',
]);

const ALLOWED_POSTER_MIMES = new Set([
	...ALLOWED_IMAGE_MIMES,
	'application/pdf',
]);

const ALLOWED_GAME_MIMES = new Set(['application/zip']);

const ALLOWED_VIDEO_MIMES = new Set([
	'video/mp4',
	'video/x-matroska',   // mkv / webm
	'video/x-msvideo',    // avi
	'video/x-ms-wmv',     // wmv
]);

export function isAllowedImageType(result: FileTypeResult): boolean {
	return ALLOWED_IMAGE_MIMES.has(result.mime);
}

export function isAllowedPosterType(result: FileTypeResult): boolean {
	return ALLOWED_POSTER_MIMES.has(result.mime);
}

export function isAllowedGameType(result: FileTypeResult): boolean {
	return ALLOWED_GAME_MIMES.has(result.mime);
}

export function isAllowedVideoType(result: FileTypeResult): boolean {
	return ALLOWED_VIDEO_MIMES.has(result.mime);
}

// Absolute per-kind size ceilings (applies to all roles).
// Role-based tighter limits are enforced in upload-limits.ts.
export const SIZE_LIMITS = {
	poster: 15 * 1024 * 1024,       // 15 MB
	posterPdf: 50 * 1024 * 1024,    // 50 MB (source PDF; rasterized output is much smaller)
	image: 15 * 1024 * 1024,        // 15 MB
	imagePdf: 100 * 1024 * 1024,    // 100 MB (source PDF; rasterized output is much smaller)
	game: 5120 * 1024 * 1024,       // 5120 MB
	video: 1024 * 1024 * 1024,      // 1024 MB
} as const;
