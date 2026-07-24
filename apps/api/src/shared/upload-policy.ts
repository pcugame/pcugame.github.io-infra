import { Transform } from 'node:stream';
import type { AssetKind } from '@pcu/contracts';
import { AppError } from './errors.js';
import { detectFileType, SIZE_LIMITS } from './file-signature.js';

/**
 * Resolved request limits. Resolution from configuration or settings belongs
 * to a composition root; this module deliberately contains no env/runtime
 * access so upload controllers can use it in an isolated context graph.
 */
export interface UploadLimits {
	posterMaxBytes: number;
	imageMaxBytes: number;
	gameMaxBytes: number;
	videoMaxBytes: number;
	requestMaxBytes: number;
	maxFiles: number;
}

export function kindLimit(limits: UploadLimits, kind: AssetKind): number {
	switch (kind) {
		case 'GAME': return limits.gameMaxBytes;
		case 'VIDEO': return limits.videoMaxBytes;
		case 'POSTER':
		case 'THUMBNAIL': return limits.posterMaxBytes;
		case 'IMAGE':
		default: return limits.imageMaxBytes;
	}
}

const FIELDNAME_MAP: Record<string, AssetKind> = {
	poster: 'POSTER',
	'images[]': 'IMAGE',
	gameFile: 'GAME',
	videoFile: 'VIDEO',
};

export function fieldnameToKind(fieldname: string): AssetKind | undefined {
	return FIELDNAME_MAP[fieldname];
}

export function createByteLimiter(maxBytes: number, label = 'File'): Transform {
	let total = 0;
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			total += chunk.length;
			if (total > maxBytes) {
				const limitMB = Math.round(maxBytes / 1024 / 1024);
				callback(
					new AppError(413, `${label} exceeds size limit of ${limitMB}MB`, 'PAYLOAD_TOO_LARGE'),
				);
				return;
			}
			callback(null, chunk);
		},
	});
}

export function kindLimitForMime(
	limits: UploadLimits,
	kind: AssetKind,
	mime?: string,
): number {
	const baseLimit = kindLimit(limits, kind);
	if (kind === 'POSTER' && mime === 'application/pdf') {
		return Math.max(baseLimit, SIZE_LIMITS.posterPdf);
	}
	if (kind === 'IMAGE' && mime === 'application/pdf') {
		return Math.max(baseLimit, SIZE_LIMITS.imagePdf);
	}
	return baseLimit;
}

export function createKindAwareByteLimiter(
	limits: UploadLimits,
	kind: AssetKind,
	label = 'File',
): Transform {
	const headerBytesNeeded = 16;
	let header = Buffer.alloc(0);
	let total = 0;
	let effectiveLimit: number | undefined;

	function resolveLimit(): number {
		if (effectiveLimit !== undefined) return effectiveLimit;
		if (header.length >= headerBytesNeeded) {
			effectiveLimit = kindLimitForMime(limits, kind, detectFileType(header)?.mime);
			return effectiveLimit;
		}
		return kindLimit(limits, kind);
	}

	function limitError(limit: number): AppError {
		const limitMB = Math.round(limit / 1024 / 1024);
		return new AppError(
			413,
			`${label} exceeds ${kind} size limit of ${limitMB}MB`,
			'PAYLOAD_TOO_LARGE',
		);
	}

	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			total += chunk.length;
			if (header.length < headerBytesNeeded) {
				const remaining = headerBytesNeeded - header.length;
				header = Buffer.concat([header, chunk.subarray(0, remaining)]);
			}
			const limit = resolveLimit();
			if (total > limit) {
				callback(limitError(limit));
				return;
			}
			callback(null, chunk);
		},
		flush(callback) {
			const limit = effectiveLimit
				?? kindLimitForMime(limits, kind, detectFileType(header)?.mime);
			if (total > limit) {
				callback(limitError(limit));
				return;
			}
			callback();
		},
	});
}
