import { attachmentContentDisposition, buildGameDownloadFilename } from '@pcu/contracts';
import type { AssetKind, UserRole } from '@pcu/contracts';
import type { Actor } from '../../application/http-input.js';
import type { HttpResponseDescriptor } from '../../shared/response-descriptor.js';
import { notFound, forbidden, unauthorized } from '../../shared/errors.js';

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

interface AssetDeletionRecord {
	id: number;
	projectId: number;
	kind: AssetKind;
	storageKey: string;
	playbackStorageKey: string | null;
	project: { posterAssetId: number | null };
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
		loadBannedIps(ips: string[]): void;
		check(ip: string): 'ok' | 'ban' | 'banned';
	};
	logger: {
		info(message: string): void;
		warn(message: string): void;
		error(context: Record<string, unknown>, message: string): void;
	};
	repository: {
		findAllBannedIps(): Promise<{ ip: string }[]>;
		findPublicAsset(key: string): Promise<unknown | null>;
		findAssetByStorageKey(key: string): Promise<ProtectedAssetStreamRecord | null>;
		upsertBannedIp(ip: string, reason: string): Promise<unknown>;
		findAssetByIdWithProject(id: number): Promise<AssetDeletionRecord | null>;
		markAssetDeleting(id: number): Promise<unknown>;
		clearPosterIfMatches(projectId: number, assetId: number): Promise<unknown>;
		markAssetDeleted(id: number): Promise<unknown>;
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

/** Initialize in-memory ban cache from DB on startup */
export async function loadBannedIpCache(deps: AssetsServiceDependencies): Promise<void> {
	try {
		const banned = await deps.repository.findAllBannedIps();
		deps.downloadLimiter.loadBannedIps(banned.map((b) => b.ip));
		if (banned.length > 0) {
			deps.logger.info(`Loaded ${banned.length} banned IPs`);
		}
	} catch {
		deps.logger.warn('Could not load banned IPs (migration may be pending)');
	}
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

/** Delete an asset: mark status, remove from S3, clear poster ref, mark deleted */
export async function deleteAsset(
	deps: AssetsServiceDependencies,
	assetId: number,
	actor: Actor,
) {
	const asset = await deps.repository.findAssetByIdWithProject(assetId);
	if (!asset) throw notFound('Asset not found');
	await deps.loadProjectWithAccess(actor, asset.projectId);

	await deps.repository.markAssetDeleting(asset.id);

	const bucket = deps.bucketForKind(asset.kind);
	await deps.deleteOrQueue(bucket, asset.storageKey, 'asset-delete', { assetId: asset.id });
	if (asset.playbackStorageKey && asset.playbackStorageKey !== asset.storageKey) {
		await deps.deleteOrQueue(bucket, asset.playbackStorageKey, 'asset-delete-playback', { assetId: asset.id });
	}

	if (asset.project.posterAssetId === asset.id) {
		await deps.repository.clearPosterIfMatches(asset.projectId, asset.id);
	}

	await deps.repository.markAssetDeleted(asset.id);

	return { projectId: asset.projectId };
}

export function createAssetsService(deps: AssetsServiceDependencies) {
	return {
		loadBannedIpCache: () => loadBannedIpCache(deps),
		streamPublicAsset: (storageKey: string) => streamPublicAsset(deps, storageKey),
		streamProtectedAsset: (
			storageKey: string,
			clientIp: string,
			user: ProtectedAssetAccessUser | undefined,
		) => streamProtectedAsset(deps, storageKey, clientIp, user),
		deleteAsset: (assetId: number, actor: Actor) => deleteAsset(deps, assetId, actor),
	};
}
