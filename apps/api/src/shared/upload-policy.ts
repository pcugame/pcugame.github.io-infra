import { Transform } from 'node:stream';
import type { AssetKind, InlineAssetKind } from '@pcu/contracts';
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

export interface RoleUploadPolicyConfig {
	INLINE_UPLOAD_MAX_BYTES?: number;
	UPLOAD_USER_IMAGE_MAX_MB: number;
	UPLOAD_USER_GAME_MAX_MB: number;
	UPLOAD_USER_REQUEST_MAX_MB: number;
	UPLOAD_USER_MAX_FILES: number;
	UPLOAD_PRIVILEGED_IMAGE_MAX_MB: number;
	UPLOAD_PRIVILEGED_GAME_MAX_MB: number;
	UPLOAD_PRIVILEGED_REQUEST_MAX_MB: number;
	UPLOAD_PRIVILEGED_MAX_FILES: number;
}

export function megabytes(value: number): number {
	return value * 1024 * 1024;
}

export function resolveRoleGameMaxBytes(
	config: Pick<RoleUploadPolicyConfig, 'UPLOAD_USER_GAME_MAX_MB' | 'UPLOAD_PRIVILEGED_GAME_MAX_MB'>,
	role: string,
): number {
	return megabytes(
		role === 'ADMIN' || role === 'OPERATOR'
			? config.UPLOAD_PRIVILEGED_GAME_MAX_MB
			: config.UPLOAD_USER_GAME_MAX_MB,
	);
}

export function resolveRoleUploadLimits(
	config: RoleUploadPolicyConfig,
	role: string,
	options: { maxGameFileMb?: number } = {},
): UploadLimits {
	const privileged = role === 'ADMIN' || role === 'OPERATOR';
	const gameMaxBytes = resolveRoleGameMaxBytes(config, role);
	const inlineMaxBytes = config.INLINE_UPLOAD_MAX_BYTES ?? megabytes(16);
	const configured: UploadLimits = privileged
		? {
			posterMaxBytes: Math.min(inlineMaxBytes, megabytes(config.UPLOAD_PRIVILEGED_IMAGE_MAX_MB)),
			imageMaxBytes: Math.min(inlineMaxBytes, megabytes(config.UPLOAD_PRIVILEGED_IMAGE_MAX_MB)),
			gameMaxBytes,
			videoMaxBytes: 0,
			requestMaxBytes: inlineMaxBytes,
			maxFiles: config.UPLOAD_PRIVILEGED_MAX_FILES,
		}
		: {
			posterMaxBytes: Math.min(inlineMaxBytes, megabytes(config.UPLOAD_USER_IMAGE_MAX_MB)),
			imageMaxBytes: Math.min(inlineMaxBytes, megabytes(config.UPLOAD_USER_IMAGE_MAX_MB)),
			gameMaxBytes,
			videoMaxBytes: 0,
			requestMaxBytes: inlineMaxBytes,
			maxFiles: config.UPLOAD_USER_MAX_FILES,
		};
	return options.maxGameFileMb === undefined
		? configured
		: {
			...configured,
			gameMaxBytes: Math.min(configured.gameMaxBytes, megabytes(options.maxGameFileMb)),
		};
}

export function bucketForAssetKind(
	kind: AssetKind,
	buckets: { publicBucket: string; protectedBucket: string },
): string {
	return kind === 'GAME' || kind === 'VIDEO' ? buckets.protectedBucket : buckets.publicBucket;
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
		return Math.min(limits.requestMaxBytes, Math.max(baseLimit, SIZE_LIMITS.posterPdf));
	}
	if (kind === 'IMAGE' && mime === 'application/pdf') {
		return Math.min(limits.requestMaxBytes, Math.max(baseLimit, SIZE_LIMITS.imagePdf));
	}
	return baseLimit;
}

export function createKindAwareByteLimiter(
	limits: UploadLimits,
	kind: InlineAssetKind,
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
