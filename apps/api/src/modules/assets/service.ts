import { attachmentContentDisposition, buildGameDownloadFilename } from '@pcu/contracts';
import type { AssetKind, UserRole } from '@pcu/contracts';
import type { Actor } from '../../application/http-input.js';
import type { HttpResponseDescriptor } from '../../shared/response-descriptor.js';
import { AppError, notFound, forbidden, unauthorized } from '../../shared/errors.js';
import type { DownloadRateLimitResult } from '../../shared/download-rate-limit.js';
import {
	authorizeAssetAction,
	type AssetDeliveryAction,
} from './delivery-policy.js';

export type AssetDownloadVariant = 'original' | 'playback';

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
	id: number;
	projectId: number;
	status: string;
	storageKey: string;
	playbackStorageKey: string | null;
	playbackStatus: string;
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
	presign(
		bucket: string,
		key: string,
		options?: { ttlSec?: number; responseContentDisposition?: string },
	): Promise<string>;
	presignTtlSec?: number;
	bucketForKind(kind: AssetKind): string;
	wakeDeletionWorker(): void;
	loadProjectWithAccess(actor: Actor, projectId: number): Promise<unknown>;
	downloadLimiter: {
		check(ip: string, scope?: string): DownloadRateLimitResult;
	};
	logger: {
		info(context: Record<string, unknown>, message: string): void;
		error(context: Record<string, unknown>, message: string): void;
	};
	repository: {
		findAssetByIdForDownload(id: number): Promise<ProtectedAssetStreamRecord | null>;
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
	check(ip: string, scope?: string): DownloadRateLimitResult;
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
	check(ip: string, scope?: string): DownloadRateLimitResult;
}): BannedIpStartupGate {
	let ready = false;
	return {
		warm(ips) {
			limiter.loadBannedIps(ips);
			ready = true;
		},
		remove: (ip) => limiter.removeBan(ip),
		check(ip, scope) {
			if (!ready) {
				throw new AppError(
					503,
					'Protected downloads are unavailable until the banned-IP cache is ready.',
					'BANNED_IP_CACHE_UNAVAILABLE',
				);
			}
			return limiter.check(ip, scope);
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
	return authorizeAssetAction({ action: 'DOWNLOAD_ORIGINAL', asset, actor: user });
}

function actionForVariant(variant: AssetDownloadVariant): AssetDeliveryAction {
	return variant === 'playback' ? 'DOWNLOAD_PLAYBACK' : 'DOWNLOAD_ORIGINAL';
}

function storageKeyForVariant(
	asset: ProtectedAssetStreamRecord,
	variant: AssetDownloadVariant,
): string {
	if (variant === 'original') return asset.storageKey;
	if (asset.kind !== 'VIDEO' || asset.playbackStatus !== 'READY') {
		throw notFound('Asset variant not found');
	}
	return asset.playbackStorageKey ?? asset.storageKey;
}

async function grantProtectedAssetDownload(
	deps: AssetsServiceDependencies,
	asset: ProtectedAssetStreamRecord,
	variant: AssetDownloadVariant,
	clientIp: string,
	user: ProtectedAssetAccessUser | undefined,
): Promise<HttpResponseDescriptor> {
	if (asset.status !== 'READY') throw notFound('Asset not found');
	const storageKey = storageKeyForVariant(asset, variant);
	const action = actionForVariant(variant);
	if (!authorizeAssetAction({ action, asset, actor: user })) {
		if (!user) throw unauthorized();
		throw forbidden('Not allowed to access this asset');
	}

	// Manual denylist is checked by the limiter before its transient bucket. The
	// scoped bucket prevents one popular object or actor from becoming a durable
	// shared-NAT denial of service.
	const limiterScope = `${user?.id ?? 'anonymous'}:${action}:${asset.id}`;
	const result = deps.downloadLimiter.check(clientIp, limiterScope);
	if (result.status === 'rate_limited') {
		const retryAfterSec = result.retryAfterSec;
		deps.logger.info({
			actorId: user?.id,
			projectId: asset.projectId,
			assetId: asset.id,
			action,
			result: 'rate_limited',
		}, 'protected_download_rate_limited');
		throw new AppError(
			429,
			'Too many protected download requests. Try again later.',
			'RATE_LIMITED',
			{ retryAfterSec },
		);
	}

	const downloadOptions = asset.kind === 'GAME'
		? {
			ttlSec: deps.presignTtlSec ?? 60,
			responseContentDisposition: attachmentContentDisposition(
				buildGameDownloadFilename(asset.project.title, asset.project.members).filename,
			),
		}
		: { ttlSec: deps.presignTtlSec ?? 60 };
	const bucket = deps.bucketForKind(asset.kind as AssetKind);
	const url = await deps.presign(bucket, storageKey, downloadOptions);
	deps.logger.info({
		actorId: user?.id,
		projectId: asset.projectId,
		assetId: asset.id,
		action,
		result: 'granted',
	}, 'protected_download_grant');
	return { status: 302, headers: { 'Referrer-Policy': 'no-referrer' }, location: url };
}

/** Canonical domain-identity route: resolve READY asset + variant, then issue a capability. */
export async function downloadAssetById(
	deps: AssetsServiceDependencies,
	assetId: number,
	variant: AssetDownloadVariant,
	clientIp: string,
	user: ProtectedAssetAccessUser | undefined,
): Promise<HttpResponseDescriptor> {
	const asset = await deps.repository.findAssetByIdForDownload(assetId);
	if (!asset) throw notFound('Asset not found');
	return grantProtectedAssetDownload(deps, asset, variant, clientIp, user);
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

	// The transaction above owns durability. The request only coalesces a worker
	// wake and never waits for the global orphan backlog.
	deps.wakeDeletionWorker();

	return { projectId: asset.projectId };
}

export function createAssetsService(deps: AssetsServiceDependencies) {
	return {
		downloadAssetById: (
			assetId: number,
			variant: AssetDownloadVariant,
			clientIp: string,
			user: ProtectedAssetAccessUser | undefined,
		) => downloadAssetById(deps, assetId, variant, clientIp, user),
		deleteAsset: (assetId: number, actor: Actor) => deleteAsset(deps, assetId, actor),
	};
}
