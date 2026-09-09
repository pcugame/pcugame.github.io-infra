import { extname } from 'node:path';
import { validateMaterialContent } from '../../asset-upload/material-validation.js';
import type { AssetKind } from '@pcu/contracts';
import type { FileSystem } from '../../../application/ports.js';
import { badRequest } from '../../../shared/errors.js';
import {
	detectFileType,
	isAllowedGameType,
	isAllowedImageType,
	isAllowedPosterType,
	isAllowedVideoType,
	SIZE_LIMITS,
} from '../../../shared/file-signature.js';
import { validateZipArchiveObject } from '../../assets/upload/zip-validation.js';
import type { ValidatedFile } from '../../assets/upload/upload-types.js';

type InlineAssetKind = Exclude<AssetKind, 'WEBGL'>;

const KIND_SIZE_LIMITS: Record<InlineAssetKind, number> = {
	DOCUMENT: 50 * 1024 * 1024,
	ATTACHMENT: 50 * 1024 * 1024,
	GAME: SIZE_LIMITS.game,
	POSTER: SIZE_LIMITS.poster,
	THUMBNAIL: SIZE_LIMITS.poster,
	IMAGE: SIZE_LIMITS.image,
	VIDEO: SIZE_LIMITS.video,
};

export async function validateProjectUploadFile(
	fileSystem: Pick<FileSystem, 'readRange' | 'stat'>,
	filePath: string,
	kind: AssetKind,
	originalName?: string,
): Promise<ValidatedFile> {
	if (kind === 'WEBGL') {
		throw badRequest('WebGL uses the direct multipart upload session');
	}
	const stat = await fileSystem.stat(filePath);
	const sizeBytes = stat.size;
	if (kind === 'DOCUMENT' || kind === 'ATTACHMENT') {
		if (sizeBytes < 1 || sizeBytes > 50 * 1024 * 1024) throw badRequest('Invalid material size');
		try {
			const mimeType = await validateMaterialContent(kind, originalName ?? '', await fileSystem.readRange(filePath, 0, sizeBytes - 1));
			return { mimeType, sizeBytes, ext: kind === 'DOCUMENT' ? extname(originalName ?? '').slice(1).toLowerCase() : 'bin' };
		} catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid material'); }
	}
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

	if (kind === 'GAME') {
		if (!isAllowedGameType(fileType)) throw badRequest('Game file must be a ZIP archive');
		await validateZipArchiveObject(
			sizeBytes,
			(start, end) => fileSystem.readRange(filePath, start, end),
		);
	} else if (kind === 'VIDEO') {
		if (!isAllowedVideoType(fileType)) throw badRequest('Unsupported video format');
	} else if (kind === 'POSTER') {
		if (!isAllowedPosterType(fileType)) {
			throw badRequest('Poster must be JPEG, PNG, WebP, or PDF');
		}
	} else if (!isAllowedImageType(fileType)) {
		throw badRequest('Images must be JPEG, PNG, WebP, or PDF');
	}

	return { mimeType: fileType.mime, ext: fileType.ext, sizeBytes };
}
