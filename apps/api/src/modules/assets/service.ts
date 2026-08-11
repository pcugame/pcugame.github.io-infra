import { attachmentContentDisposition, buildGameDownloadFilename } from '@pcu/contracts';
import type { AssetKind, UserRole } from '@pcu/contracts';
import type { Actor } from '../../application/http-input.js';
import type { HttpResponseDescriptor } from '../../shared/response-descriptor.js';
import { AppError, notFound, forbidden, unauthorized } from '../../shared/errors.js';

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

interface ProtectedAssetStreamRecord extends ProtectedAssetAccessRecord {
	project: ProtectedAssetAccessRecord['project'] & {
		title: string;
		members: {
			id: number;
			userId: number | null;
			name: string;
			studentId: string;
			sortOrder: number;
		}[];
	};
}

interface AssetDeletionLookup {
	id: number;
	projectId: number;
	project: { posterAssetId: number | null };
}

interface AssetDeletionClaim {
	id: number;
	projectId: number;
	kind: AssetKind;
	previousStatus: 'READY' | 'DELETING' | 'DELETED' | 'FAILED';
	storageKey: string;
	playbackStorageKey: string | null;
	alreadyDeleted: boolean;
}

export interface AssetsServiceDependencies {
	publicBucket: string;
	protectedBucket: string;
	presign(
		bucket: string,
		key: string,
		options?: { responseContentDisposition: string },
	): Promise<string>;
	bucketForKind(kind: AssetKind): string;
	deleteOrQueue(
		bucket: string,
		key: string,
		reason: string,
		context: Record<string, unknown>,
	): Promise<void>;
	loadProjectWithAccess(actor: Actor, projectId: number): Promise<unknown>;
	downloadLimiter: {
		check(ip: string): 'ok' | 'ban';
	};
	logger: {
		info(message: string): void;
		error(context: Record<string, unknown>, message: string): void;
	};
	recordPostCommitCleanupFailure?: () => void;
	repository: {
		findPublicAsset(key: string): Promise<unknown | null>;
		findAssetByStorageKey(key: string): Promise<ProtectedAssetStreamRecord | null>;
		upsertBannedIp(ip: string, reason: string): Promise<unknown>;
		findAssetByIdWithProject(id: number): Promise<AssetDeletionLookup | null>;
		claimAssetForDeletion(id: number): Promise<AssetDeletionClaim | null>;
		completeAssetDeletion(
			claim: AssetDeletionClaim,
			outbox: { bucket: string; reason: string; playbackReason: string },
		): Promise<void>;
	};
}

export interface BannedIpStartupGate {
	warm(ips: string[]): void;
	remove(ip: string): void;
	check(ip: string): 'ok' | 'ban';
	isReady(): boolean;
}

/**
 * Protected downloads fail closed until the context-owned startup warmup has
 * atomically installed the DB snapshot. A constructed/registered app can never
 * interpret an uninitialized empty set as "no banned IPs".
 */
export function createBannedIpStartupGate(limiter: {
	loadBannedIps(ips: string[]): void;
	removeBan(ip: string): void;
	check(ip: string): 'ok' | 'ban';
}): BannedIpStartupGate {
	let ready = false;
	return {
		warm(ips) {
			limiter.loadBannedIps(ips);
			ready = true;
		},
		remove: (ip) => limiter.removeBan(ip),
		check(ip) {
			if (!ready) {
				throw new AppError(
					503,
					'Protected downloads are unavailable until the banned-IP cache is ready.',
					'BANNED_IP_CACHE_UNAVAILABLE',
				);
			}
			return limiter.check(ip);
		},
		isReady: () => ready,
	};
}

/** Explicit startup owner. A DB failure is fatal and remains rejected. */
export function createBannedIpWarmup(deps: {
	repository: { findAllBannedIps(): Promise<{ ip: string }[]> };
	gate: Pick<BannedIpStartupGate, 'warm'>;
	logger: { info(value: unknown, message?: string): void; error(value: unknown, message?: string): void };
}): { start(): Promise<void> } {
	let startPromise: Promise<void> | undefined;
	return {
		start() {
			startPromise ??= (async () => {
				try {
					const banned = await deps.repository.findAllBannedIps();
					deps.gate.warm(banned.map(({ ip }) => ip));
					deps.logger.info({ count: banned.length }, 'Loaded banned IP cache');
				} catch (error) {
					deps.logger.error(error, 'Banned IP cache warmup failed; aborting startup');
					throw error;
				}
			})();
			return startPromise;
		},
	};
}

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

/** Redirect to a presigned S3 URL for a public asset */
export async function streamPublicAsset(
	deps: AssetsServiceDependencies,
	storageKey: string,
): Promise<HttpResponseDescriptor> {
	const asset = await deps.repository.findPublicAsset(storageKey);
	if (!asset) throw notFound('Asset not found');

	const url = await deps.presign(deps.publicBucket, storageKey);
	return { status: 302, headers: { 'Referrer-Policy': 'no-referrer' }, location: url };
}

/** Redirect to a presigned S3 URL for a protected asset with IP-based rate limiting */
export async function streamProtectedAsset(
	deps: AssetsServiceDependencies,
	storageKey: string,
	clientIp: string,
	user: ProtectedAssetAccessUser | undefined,
): Promise<HttpResponseDescriptor> {
	const asset = await deps.repository.findAssetByStorageKey(storageKey);
	if (!asset) throw notFound('Asset not found');
	if (!canStreamProtectedAsset(asset, user)) {
		if (!user) throw unauthorized();
		throw forbidden('Not allowed to access this asset');
	}

	// Count only authorized protected redirects so access checks cannot be bypassed
	// or masked by rate-limit state.
	const result = deps.downloadLimiter.check(clientIp);
	if (result === 'ban') {
		await deps.repository.upsertBannedIp(clientIp, 'Rate limit exceeded (protected asset download)')
			.catch((err) => deps.logger.error({ err }, 'Failed to persist IP ban'));
		throw forbidden('Your IP has been blocked due to excessive download requests. Contact an administrator.');
	}

	const downloadOptions = asset.kind === 'GAME'
		? {
			responseContentDisposition: attachmentContentDisposition(
				buildGameDownloadFilename(asset.project.title, asset.project.members).filename,
			),
		}
		: undefined;
	const url = downloadOptions
		? await deps.presign(deps.protectedBucket, storageKey, downloadOptions)
		: await deps.presign(deps.protectedBucket, storageKey);
	return { status: 302, headers: { 'Referrer-Policy': 'no-referrer' }, location: url };
}

/** Delete an asset using a locked DB identity claim around storage I/O. */
export async function deleteAsset(
	deps: AssetsServiceDependencies,
	assetId: number,
	actor: Actor,
) {
	const lookup = await deps.repository.findAssetByIdWithProject(assetId);
	if (!lookup) throw notFound('Asset not found');
	await deps.loadProjectWithAccess(actor, lookup.projectId);

	const asset = await deps.repository.claimAssetForDeletion(assetId);
	if (!asset) throw notFound('Asset not found');
	const bucket = deps.bucketForKind(asset.kind);
	await deps.repository.completeAssetDeletion(asset, {
		bucket,
		reason: 'asset-delete',
		playbackReason: 'asset-delete-playback',
	});

	// The transaction above owns durability. A failed immediate reap is logged
	// and retried by maintenance; it must not turn a committed delete into 500.
	await Promise.all([
		deps.deleteOrQueue(bucket, asset.storageKey, 'asset-delete', { assetId: asset.id }),
		...(asset.playbackStorageKey && asset.playbackStorageKey !== asset.storageKey
			? [deps.deleteOrQueue(
				bucket,
				asset.playbackStorageKey,
				'asset-delete-playback',
				{ assetId: asset.id },
			)]
			: []),
	]).catch((err) => {
		deps.recordPostCommitCleanupFailure?.();
		deps.logger.error(
			{ err, assetId: asset.id, projectId: asset.projectId },
			'Post-commit asset cleanup failed; durable outbox retained',
		);
	});

	return { projectId: asset.projectId };
}

export function createAssetsService(deps: AssetsServiceDependencies) {
	return {
		streamPublicAsset: (storageKey: string) => streamPublicAsset(deps, storageKey),
		streamProtectedAsset: (
			storageKey: string,
			clientIp: string,
			user: ProtectedAssetAccessUser | undefined,
		) => streamProtectedAsset(deps, storageKey, clientIp, user),
		deleteAsset: (assetId: number, actor: Actor) => deleteAsset(deps, assetId, actor),
	};
}
