import type { AdminProjectDetail, AssetKind, AssetPlaybackStatus, Platform, ProjectStatus } from '@pcu/contracts';
import { isPosterUrlSafe } from '../../../shared/poster-validation.js';
import { effectiveIsIncomplete } from '../../../shared/project-completeness.js';
import { parseWebglEntryKey, webglUrl } from '../../webgl/paths.js';

function assetUrlFor(base: string, storageKey: string, kind: AssetKind): string {
	if (kind === 'GAME' || kind === 'VIDEO') return `${base}/api/assets/protected/${storageKey}`;
	return `${base}/api/assets/public/${storageKey}`;
}

export type SerializableAsset = {
	id: number;
	kind: AssetKind;
	storageKey: string;
	playbackStorageKey: string | null;
	originalName: string;
	mimeType: string;
	playbackMimeType: string;
	sizeBytes: bigint;
	playbackSizeBytes: bigint;
	playbackStatus: AssetPlaybackStatus;
	playbackError: string;
};

function playbackKeyFor(asset: SerializableAsset): string {
	return asset.kind === 'VIDEO' && asset.playbackStorageKey
		? asset.playbackStorageKey
		: asset.storageKey;
}

function playbackMimeFor(asset: SerializableAsset): string {
	return asset.kind === 'VIDEO' && asset.playbackStorageKey
		? asset.playbackMimeType || 'video/mp4'
		: asset.mimeType || 'video/mp4';
}

/** Serialize a project detail record to the API response shape */
export type SerializableProject = {
	id: number;
	title: string;
	slug: string;
	exhibition: { year: number };
	summary: string;
	description: string;
	githubUrl: string;
	platforms: Platform[];
	isIncomplete: boolean;
	status: ProjectStatus;
	sortOrder: number;
	posterAssetId: number | null;
	webglEntryKey?: string;
	poster: { storageKey: string; kind: AssetKind; status: string } | null;
	members: { id: number; name: string; studentId: string; sortOrder: number; userId: number | null }[];
	assets: SerializableAsset[];
};

export function createProjectSerializer(baseUrl: string) {
	const base = baseUrl.replace(/\/$/, '');
	const assetUrl = (storageKey: string, kind: AssetKind) => assetUrlFor(base, storageKey, kind);

	function serializeProjectDetail(project: SerializableProject): AdminProjectDetail {
		const videos = project.assets
			.filter((a) => a.kind === 'VIDEO')
			.map((videoAsset) => ({
				url: assetUrl(playbackKeyFor(videoAsset), 'VIDEO'),
				mimeType: playbackMimeFor(videoAsset),
				originalDownloadUrl: assetUrl(videoAsset.storageKey, 'VIDEO'),
				playbackStatus: videoAsset.playbackStatus,
				playbackError: videoAsset.playbackError || undefined,
			}));
		const video = videos[0] ?? null;

		return {
			id: project.id,
			title: project.title,
			slug: project.slug,
			year: project.exhibition.year,
			summary: project.summary || undefined,
			description: project.description || undefined,
			githubUrl: project.githubUrl || undefined,
			platforms: project.platforms,
			isIncomplete: effectiveIsIncomplete(project.isIncomplete, project.assets, project.poster),
			video,
			videos,
			status: project.status,
			sortOrder: project.sortOrder,
			posterAssetId: project.posterAssetId ?? undefined,
			posterUrl: isPosterUrlSafe(project.poster)
				? assetUrl(project.poster!.storageKey, 'POSTER')
				: undefined,
			webglUrl: parseWebglEntryKey(project.id, project.webglEntryKey ?? '')
				? webglUrl(base, project.id)
				: undefined,
			members: project.members.map((m) => ({
				id: m.id,
				name: m.name,
				studentId: m.studentId,
				sortOrder: m.sortOrder,
				userId: m.userId,
			})),
			assets: project.assets.map((a) => ({
				id: a.id,
				kind: a.kind,
				url: assetUrl(a.storageKey, a.kind),
				originalDownloadUrl: a.kind === 'VIDEO' ? assetUrl(a.storageKey, a.kind) : undefined,
				playbackUrl: a.kind === 'VIDEO' ? assetUrl(playbackKeyFor(a), a.kind) : undefined,
				playbackStatus: a.kind === 'VIDEO' ? a.playbackStatus : undefined,
				playbackError: a.kind === 'VIDEO' && a.playbackError ? a.playbackError : undefined,
				originalName: a.originalName,
				size: Number(a.sizeBytes),
			})),
		};
	}

	return { assetUrl, serializeProjectDetail };
}
