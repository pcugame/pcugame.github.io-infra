import type { InlineAssetKind } from '@pcu/contracts';
import type { FileSystem } from '../../../application/ports.js';
import { badRequest } from '../../../shared/errors.js';
import {
	detectFileType,
	isAllowedImageType,
	isAllowedPosterType,
	SIZE_LIMITS,
} from '../../../shared/file-signature.js';
import type { ValidatedFile } from '../../assets/upload/upload-types.js';

const KIND_SIZE_LIMITS: Record<InlineAssetKind, number> = {
	POSTER: SIZE_LIMITS.poster,
	THUMBNAIL: SIZE_LIMITS.poster,
	IMAGE: SIZE_LIMITS.image,
};

export async function validateProjectUploadFile(
	fileSystem: Pick<FileSystem, 'readRange' | 'stat'>,
	filePath: string,
	kind: InlineAssetKind,
): Promise<ValidatedFile> {
	const stat = await fileSystem.stat(filePath);
	const sizeBytes = stat.size;
	const fileType = detectFileType(await fileSystem.readRange(filePath, 0, 15));
	if (!fileType) throw badRequest('Unsupported file type');

	const isPosterPdf = kind === 'POSTER' && fileType.mime === 'application/pdf';
	const isImagePdf = kind === 'IMAGE' && fileType.mime === 'application/pdf';
	const limit = isPosterPdf
		? SIZE_LIMITS.posterPdf
		: isImagePdf
			? SIZE_LIMITS.imagePdf
			: KIND_SIZE_LIMITS[kind];
	if (sizeBytes > limit) throw badRequest(`File too large for kind ${kind}`);

	if (kind === 'POSTER') {
		if (!isAllowedPosterType(fileType)) {
			throw badRequest('Poster must be JPEG, PNG, WebP, or PDF');
		}
	} else if (!isAllowedImageType(fileType)) {
		throw badRequest('Images must be JPEG, PNG, WebP, or PDF');
	}

	return { mimeType: fileType.mime, ext: fileType.ext, sizeBytes };
}
