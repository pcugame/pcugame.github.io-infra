import { env } from '../../../config/env.js';

const MB = 1024 * 1024;

export function resolveChunkSizeBytes(
	settings: { maxChunkSizeMb: number },
	cfg: { UPLOAD_CHUNK_SIZE_MB: number } = env(),
): number {
	return Math.max(1, Math.floor(Math.min(settings.maxChunkSizeMb, cfg.UPLOAD_CHUNK_SIZE_MB) * MB));
}

export function chunkUploadBodyLimitBytes(cfg: { UPLOAD_CHUNK_SIZE_MB: number } = env()): number {
	return Math.max(1, Math.floor(cfg.UPLOAD_CHUNK_SIZE_MB * MB));
}
