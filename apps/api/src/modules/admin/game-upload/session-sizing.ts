const MB = 1024 * 1024;
export const MIN_MULTIPART_CHUNK_MB = 5;

export function resolveChunkSizeBytes(
	settings: { maxChunkSizeMb: number },
	cfg: { UPLOAD_CHUNK_SIZE_MB: number },
): number {
	const chunkSizeMb = Math.min(settings.maxChunkSizeMb, cfg.UPLOAD_CHUNK_SIZE_MB);
	if (!Number.isFinite(chunkSizeMb) || chunkSizeMb <= 0) {
		throw new RangeError('Multipart chunk size must be a positive finite number');
	}
	// The migration and settings API prevent values below five. Clamping here is
	// defense in depth for a stale cache during a rolling deployment.
	return Math.floor(Math.max(MIN_MULTIPART_CHUNK_MB, chunkSizeMb) * MB);
}

export function chunkUploadBodyLimitBytes(cfg: { UPLOAD_CHUNK_SIZE_MB: number }): number {
	return Math.max(
		MIN_MULTIPART_CHUNK_MB * MB,
		Math.floor(cfg.UPLOAD_CHUNK_SIZE_MB * MB),
	);
}
