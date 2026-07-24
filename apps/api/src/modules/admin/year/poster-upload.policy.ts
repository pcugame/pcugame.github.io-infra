import { Transform } from 'node:stream';
import type { UploadLimits } from '../../../shared/upload-limits.js';
import { AppError } from '../../../shared/errors.js';
import { detectFileType, SIZE_LIMITS } from '../../../shared/file-signature.js';

type PosterUploadLimits = Pick<UploadLimits, 'posterMaxBytes'>;

function limitError(limit: number, label: string): AppError {
	const limitMB = Math.round(limit / 1024 / 1024);
	return new AppError(
		413,
		`${label} exceeds POSTER size limit of ${limitMB}MB`,
		'PAYLOAD_TOO_LARGE',
	);
}

/**
 * POSTER-only streaming policy with no env cache or process limiter dependency.
 * The first 16 bytes select the larger source-PDF ceiling; browser images keep
 * the role-specific limit and are still subject to the absolute 15 MiB check.
 */
export function createPosterByteLimiter(
	limits: PosterUploadLimits,
	label = 'File',
): Transform {
	const headerBytesNeeded = 16;
	let header = Buffer.alloc(0);
	let total = 0;
	let effectiveLimit: number | undefined;

	function resolveLimit(): number {
		if (effectiveLimit !== undefined) return effectiveLimit;
		if (header.length >= headerBytesNeeded) {
			effectiveLimit = detectFileType(header)?.mime === 'application/pdf'
				? Math.max(limits.posterMaxBytes, SIZE_LIMITS.posterPdf)
				: limits.posterMaxBytes;
		}
		return effectiveLimit ?? limits.posterMaxBytes;
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
				callback(limitError(limit, label));
				return;
			}
			callback(null, chunk);
		},
		flush(callback) {
			const limit = detectFileType(header)?.mime === 'application/pdf'
				? Math.max(limits.posterMaxBytes, SIZE_LIMITS.posterPdf)
				: limits.posterMaxBytes;
			if (total > limit) {
				callback(limitError(limit, label));
				return;
			}
			callback();
		},
	});
}
