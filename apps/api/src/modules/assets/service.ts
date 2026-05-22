import type { FastifyReply } from 'fastify';
import type { UserRole } from '@prisma/client';
import { env } from '../../config/env.js';
import { notFound, forbidden, unauthorized } from '../../shared/errors.js';
import { bucketForKind } from '../../lib/s3.js';
import { getPresignedUrl, safeDeleteObject } from '../../lib/storage.js';
import { gameDownloadLimiter } from '../../shared/game-download-limiter.js';
import { logger } from '../../lib/logger.js';
import * as repo from './repository.js';

type ProtectedAssetAccessUser = {
	id: number;
	role: UserRole;
};

type ProtectedAssetAccessRecord = {
	kind: string;
	project: {
		creatorId: number;
		status: string;
		members: { userId: number | null }[];
	};
};

export function canStreamProtectedAsset(
	asset: ProtectedAssetAccessRecord,
	user?: ProtectedAssetAccessUser,
): boolean {
	const isPublicProject = asset.project.status === 'PUBLISHED' || asset.project.status === 'ARCHIVED';
	if (isPublicProject && (asset.kind === 'GAME' || asset.kind === 'VIDEO')) {
		return true;
	}

	if (!user) return false;
	if (user.role === 'ADMIN' || user.role === 'OPERATOR') return true;
	if (asset.project.creatorId === user.id) return true;
	return asset.project.members.some((member) => member.userId === user.id);
}

/** Initialize in-memory ban cache from DB on startup */
export async function loadBannedIpCache(): Promise<void> {
	try {
		const banned = await repo.findAllBannedIps();
		gameDownloadLimiter.loadBannedIps(banned.map((b) => b.ip));
		if (banned.length > 0) {
			logger().info(`Loaded ${banned.length} banned IPs`);
		}
	} catch {
		logger().warn('Could not load banned IPs (migration may be pending)');
	}
}

/** Redirect to a presigned S3 URL for a public asset */
export async function streamPublicAsset(storageKey: string, reply: FastifyReply) {
	const asset = await repo.findPublicAsset(storageKey);
	if (!asset) throw notFound('Asset not found');

	const url = await getPresignedUrl(env().S3_BUCKET_PUBLIC, storageKey);
	reply.header('Referrer-Policy', 'no-referrer');
	return reply.redirect(url, 302);
}

/** Redirect to a presigned S3 URL for a protected asset with IP-based rate limiting */
export async function streamProtectedAsset(
	storageKey: string,
	clientIp: string,
	user: ProtectedAssetAccessUser | undefined,
	reply: FastifyReply,
) {
	const asset = await repo.findAssetByStorageKey(storageKey);
	if (!asset) throw notFound('Asset not found');
	if (!canStreamProtectedAsset(asset, user)) {
		if (!user) throw unauthorized();
		throw forbidden('Not allowed to access this asset');
	}

	// GAME downloads get IP-based abuse prevention
	if (asset.kind === 'GAME') {
		const result = gameDownloadLimiter.check(clientIp);
		if (result === 'ban') {
			await repo.upsertBannedIp(clientIp, 'Rate limit exceeded (game download)')
				.catch((err) => logger().error({ err }, 'Failed to persist IP ban'));
			throw forbidden('Your IP has been blocked due to excessive download requests. Contact an administrator.');
		}
	}

	const url = await getPresignedUrl(env().S3_BUCKET_PROTECTED, storageKey);
	reply.header('Referrer-Policy', 'no-referrer');
	return reply.redirect(url, 302);
}

/** Delete an asset: mark status, remove from S3, clear poster ref, mark deleted */
export async function deleteAsset(assetId: number) {
	const asset = await repo.findAssetByIdWithProject(assetId);
	if (!asset) throw notFound('Asset not found');

	await repo.markAssetDeleting(asset.id);

	const bucket = bucketForKind(asset.kind);
	await safeDeleteObject(bucket, asset.storageKey, 'asset-delete', { assetId: asset.id });
	if (asset.playbackStorageKey && asset.playbackStorageKey !== asset.storageKey) {
		await safeDeleteObject(bucket, asset.playbackStorageKey, 'asset-delete-playback', { assetId: asset.id });
	}

	if (asset.project.posterAssetId === asset.id) {
		await repo.clearPosterIfMatches(asset.projectId, asset.id);
	}

	await repo.markAssetDeleted(asset.id);

	return { projectId: asset.projectId };
}
