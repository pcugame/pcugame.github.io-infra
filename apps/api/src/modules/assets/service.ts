import { promises as fsp, createReadStream } from 'node:fs';
import type { FastifyReply } from 'fastify';
import { env } from '../../config/env.js';
import { notFound, forbidden } from '../../shared/errors.js';
import { buildStoragePath } from '../../shared/storage-path.js';
import { gameDownloadLimiter } from '../../shared/game-download-limiter.js';
import { logger } from '../../lib/logger.js';
import * as repo from './repository.js';

/** Initialize in-memory ban cache from DB on startup */
export async function loadBannedIpCache(): Promise<void> {
	try {
		const banned = await repo.findAllBannedIps();
		gameDownloadLimiter.loadBannedIps(banned.map((b) => b.ip));
		if (banned.length > 0) {
			logger.info(`Loaded ${banned.length} banned IPs`);
		}
	} catch {
		logger.warn('Could not load banned IPs (migration may be pending)');
	}
}

/** Stream a public asset to the client with immutable caching */
export async function streamPublicAsset(storageKey: string, reply: FastifyReply) {
	const asset = await repo.findPublicAsset(storageKey);
	if (!asset) throw notFound('Asset not found');

	const filePath = buildStoragePath(env().UPLOAD_ROOT_PUBLIC, storageKey);
	try { await fsp.access(filePath); }
	catch { throw notFound('File not found'); }

	reply.header('Content-Type', asset.mimeType);
	reply.header('Content-Length', asset.sizeBytes.toString());
	reply.header('Cache-Control', 'public, max-age=31536000, immutable');
	return reply.send(createReadStream(filePath));
}

/** Stream a protected asset with IP-based rate limiting for game downloads */
export async function streamProtectedAsset(storageKey: string, clientIp: string, reply: FastifyReply) {
	const asset = await repo.findAssetByStorageKey(storageKey);
	if (!asset) throw notFound('Asset not found');

	// GAME downloads get IP-based abuse prevention
	if (asset.kind === 'GAME') {
		const result = gameDownloadLimiter.check(clientIp);
		if (result === 'ban') {
			await repo.upsertBannedIp(clientIp, 'Rate limit exceeded (game download)')
				.catch((err) => logger.error({ err }, 'Failed to persist IP ban'));
			throw forbidden('Your IP has been blocked due to excessive download requests. Contact an administrator.');
		}
	}

	const filePath = buildStoragePath(env().UPLOAD_ROOT_PROTECTED, storageKey);
	try { await fsp.access(filePath); }
	catch { throw notFound('File not found'); }

	reply.header('Content-Type', asset.mimeType);
	reply.header('Content-Length', asset.sizeBytes.toString());
	reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(asset.originalName)}"`);
	return reply.send(createReadStream(filePath));
}

/** Delete an asset: mark status, remove file, clear poster ref, mark deleted */
export async function deleteAsset(assetId: number) {
	const asset = await repo.findAssetByIdWithProject(assetId);
	if (!asset) throw notFound('Asset not found');

	await repo.markAssetDeleting(asset.id);

	const cfg = env();
	const root = asset.kind === 'GAME' ? cfg.UPLOAD_ROOT_PROTECTED : cfg.UPLOAD_ROOT_PUBLIC;
	const filePath = buildStoragePath(root, asset.storageKey);
	await fsp.unlink(filePath).catch(() => {});

	if (asset.project.posterAssetId === asset.id) {
		await repo.clearPosterIfMatches(asset.projectId, asset.id);
	}

	await repo.markAssetDeleted(asset.id);

	return { projectId: asset.projectId };
}
