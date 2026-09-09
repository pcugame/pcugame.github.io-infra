import { attachmentContentDisposition, buildGameDownloadFilename } from '@pcu/contracts';
import type { AssetKind, UserRole } from '@pcu/contracts';
import type { Actor } from '../../application/http-input.js';
import type { HttpResponseDescriptor } from '../../shared/response-descriptor.js';
import { AppError, notFound, forbidden, unauthorized } from '../../shared/errors.js';
import type { DownloadRateLimitResult } from '../../shared/download-rate-limit.js';
import {
	authorizeAssetDelivery,
	type AssetDeliveryAction,
} from './delivery-policy.js';
import {
	resolveDownloadRepresentation,
	type AssetDownloadIdentity,
	type AssetDownloadVariant,
} from './download-resolver.js';

export type { AssetDownloadVariant } from './download-resolver.js';

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

interface ProtectedAssetDownloadRecord extends AssetDownloadIdentity {
	originalName?: string;
	projectId: number | null;
	project: (ProtectedAssetAccessRecord['project'] & {
		title: string;
		members: {
			id: number;
			userId: number | null;
			name: string;
			studentId: string;
			sortOrder: number;
		}[];
	}) | null;
}

interface MigrationObservation {
	name: 'asset_download_legacy_fallback' | 'asset_download_legacy_route';
	scope: AssetDownloadVariant;
	observedAt: Date;
	details: { assetId: number; role: 'ORIGINAL' | 'PLAYBACK' };
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
	previousStatus: 'PENDING' | 'VERIFYING' | 'PROCESSING' | 'READY' | 'DELETING' | 'DELETED' | 'FAILED';
	storageKey: string | null;
	playbackStorageKey: string | null;
	alreadyDeleted: boolean;
}

export interface AssetsServiceDependencies {
	protectedBucket: string;
	presignTtlSec?: number;
	presign(
		bucket: string,
		key: string,
		options?: { ttlSec?: number; responseContentDisposition?: string },
	): Promise<string>;
	clock?: { now(): Date };
	bucketForKind(kind: AssetKind): string;
	wakeDeletionWorker(): void;
	loadProjectWithAccess(actor: Actor, projectId: number): Promise<unknown>;
	downloadLimiter: {
		check(ip: string, principalScope?: string): DownloadRateLimitResult | 'ok' | 'ban';
	};
	logger: {
		info(context: Record<string, unknown>, message: string): void;
		warn?(context: Record<string, unknown>, message: string): void;
		error(context: Record<string, unknown>, message: string): void;
	};
	repository: {
		findAssetByIdForDownload(id: number): Promise<ProtectedAssetDownloadRecord | null>;
		findAssetsByLegacyStorageKey(key: string): Promise<ProtectedAssetDownloadRecord[]>;
		recordMigrationObservations(observations: MigrationObservation[]): Promise<void>;
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
	check(ip: string, principalScope?: string): DownloadRateLimitResult;
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
	check(ip: string, principalScope?: string): DownloadRateLimitResult;
}): BannedIpStartupGate {
	let ready = false;
	return {
		warm(ips) {
			limiter.loadBannedIps(ips);
			ready = true;
		},
		remove: (ip) => limiter.removeBan(ip),
		check(ip, principalScope) {
			if (!ready) {
				throw new AppError(
					503,
					'Protected downloads are unavailable until the banned-IP cache is ready.',
					'BANNED_IP_CACHE_UNAVAILABLE',
				);
			}
			return limiter.check(ip, principalScope);
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
	return authorizeAssetDelivery({ action: 'DOWNLOAD_ORIGINAL', asset, actor: user });
}

function actionFor(variant: AssetDownloadVariant): AssetDeliveryAction {
	return variant === 'playback' ? 'DOWNLOAD_PLAYBACK' : 'DOWNLOAD_ORIGINAL';
}

async function recordCompatibilityReads(
	deps: AssetsServiceDependencies,
	assetId: number,
	variant: AssetDownloadVariant,
	role: 'ORIGINAL' | 'PLAYBACK',
	legacyFallback: boolean,
	legacyRoute: boolean,
): Promise<void> {
	const observedAt = deps.clock?.now() ?? new Date();
	const observations: MigrationObservation[] = [
		...(legacyFallback ? [{
			name: 'asset_download_legacy_fallback' as const,
			scope: variant,
			observedAt,
			details: { assetId, role },
		}] : []),
		...(legacyRoute ? [{
			name: 'asset_download_legacy_route' as const,
			scope: variant,
			observedAt,
			details: { assetId, role },
		}] : []),
	];
	if (observations.length === 0) return;
	await deps.repository.recordMigrationObservations(observations);
	for (const observation of observations) {
		deps.logger.warn?.({
			metric: observation.name,
			assetId,
			variant,
			role,
		}, 'protected_download_compatibility_read');
	}
}

async function grantProtectedAssetDownload(
	deps: AssetsServiceDependencies,
	asset: ProtectedAssetDownloadRecord,
	variant: AssetDownloadVariant,
	clientIp: string,
	user: ProtectedAssetAccessUser | undefined,
	legacyRoute: boolean,
): Promise<HttpResponseDescriptor> {
	if (!asset.project || asset.projectId === null) {
		throw new AppError(500, 'Protected asset has no project identity', 'INTERNAL_ERROR');
	}
	const action = actionFor(variant);
	if (!authorizeAssetDelivery({ action, asset: { ...asset, project: asset.project }, actor: user })) {
		if (!user) throw unauthorized();
		throw forbidden('Not allowed to access this asset');
	}
	const representation = resolveDownloadRepresentation(asset, variant, deps.protectedBucket);

	const principalScope = user
		? `user:${user.id}:${action}:${asset.id}`
		: `anonymous:${clientIp}:${action}:${asset.id}`;
	const result = deps.downloadLimiter.check(clientIp, principalScope);
	if (result !== 'ok' && result !== 'ban' && result.status === 'rate_limited') {
		throw new AppError(
			429,
			'Too many protected download requests. Try again later.',
			'RATE_LIMITED',
			{ retryAfterSec: result.retryAfterSec },
		);
	}
	if (result === 'ban' || (result !== 'ok' && result.status === 'abuse_ceiling')) {
		await deps.repository.upsertBannedIp(clientIp, 'Protected download IP abuse ceiling exceeded')
			.catch((err) => deps.logger.error({ err }, 'Failed to persist IP ban'));
		throw forbidden('Your IP has been blocked due to excessive download requests. Contact an administrator.');
	}

	await recordCompatibilityReads(
		deps,
		asset.id,
		variant,
		representation.role,
		representation.source === 'legacy',
		legacyRoute,
	);
	const downloadOptions = asset.kind === 'GAME'
		? {
			ttlSec: deps.presignTtlSec ?? 60,
			responseContentDisposition: attachmentContentDisposition(
				buildGameDownloadFilename(asset.project.title, asset.project.members).filename,
			),
		}
		: { ttlSec: deps.presignTtlSec ?? 60, ...((asset.kind === 'DOCUMENT' || asset.kind === 'ATTACHMENT') ? { responseContentDisposition: attachmentContentDisposition(asset.originalName ?? `material-${asset.id}`) } : {}) };
	const url = await deps.presign(
		representation.bucket,
		representation.objectKey,
		downloadOptions,
	);
	return { status: 302, headers: { 'Referrer-Policy': 'no-referrer' }, location: url };
}

export async function downloadAssetById(
	deps: AssetsServiceDependencies,
	assetId: number,
	variant: AssetDownloadVariant,
	clientIp: string,
	user: ProtectedAssetAccessUser | undefined,
): Promise<HttpResponseDescriptor> {
	const asset = await deps.repository.findAssetByIdForDownload(assetId);
	if (!asset) throw notFound('Asset not found');
	return grantProtectedAssetDownload(deps, asset, variant, clientIp, user, false);
}

/** Phase-1 bridge: resolve legacy physical identity, then use the canonical grant path. */
export async function downloadAssetByLegacyStorageKey(
	deps: AssetsServiceDependencies,
	storageKey: string,
	clientIp: string,
	user: ProtectedAssetAccessUser | undefined,
): Promise<HttpResponseDescriptor> {
	const assets = await deps.repository.findAssetsByLegacyStorageKey(storageKey);
	if (assets.length === 0) throw notFound('Asset not found');
	if (assets.length !== 1) {
		throw new AppError(500, 'Legacy storage identity has duplicate ownership', 'INTERNAL_ERROR');
	}
	const asset = assets[0]!;
	const original = asset.storageKey === storageKey;
	const playback = asset.playbackStorageKey === storageKey;
	if (original === playback) {
		throw new AppError(500, 'Legacy storage identity is ambiguous', 'INTERNAL_ERROR');
	}
	return grantProtectedAssetDownload(
		deps,
		asset,
		playback ? 'playback' : 'original',
		clientIp,
		user,
		true,
	);
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
		downloadAssetByLegacyStorageKey: (
			storageKey: string,
			clientIp: string,
			user: ProtectedAssetAccessUser | undefined,
		) => downloadAssetByLegacyStorageKey(deps, storageKey, clientIp, user),
		deleteAsset: (assetId: number, actor: Actor) => deleteAsset(deps, assetId, actor),
	};
}
