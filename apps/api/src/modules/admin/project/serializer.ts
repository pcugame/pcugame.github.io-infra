import type { AdminProjectDetail, AssetKind, AssetPlaybackStatus, Platform, ProjectStatus } from '@pcu/contracts';
import { isPosterUrlSafe } from '../../../shared/poster-validation.js';
import { effectiveIsIncomplete } from '../../../shared/project-completeness.js';
import {
	createResponsiveImageSerializer,
} from '../../../shared/responsive-image.js';
import { parseWebglEntryKey, webglUrl } from '../../webgl/paths.js';

function protectedAssetUrlFor(base: string, assetId: number, variant: 'original' | 'playback' = 'original'): string {
	return `${base}/api/assets/${assetId}/download?variant=${variant}`;
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
	width?: number | null;
	height?: number | null;
	card480Height?: number | null;
	display960Height?: number | null;
	playbackSizeBytes: bigint;
	playbackStatus: AssetPlaybackStatus;
	playbackError: string;
};

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
	poster: {
		storageKey: string;
		kind: AssetKind;
		status: string;
		width?: number | null;
		height?: number | null;
		card480Height?: number | null;
		display960Height?: number | null;
	} | null;
	members: { id: number; name: string; studentId: string; sortOrder: number; userId: number | null }[];
	assets: SerializableAsset[];
};

export function createProjectSerializer(apiPublicUrl: string, publicAssetBaseUrl: string) {
	const base = apiPublicUrl.replace(/\/$/, '');
	const protectedAssetUrl = (assetId: number, variant: 'original' | 'playback' = 'original') => (
		protectedAssetUrlFor(base, assetId, variant)
	);
	const responsiveImages = createResponsiveImageSerializer(publicAssetBaseUrl);

	function serializeProjectDetail(project: SerializableProject): AdminProjectDetail {
		const videos = project.assets
			.filter((a) => a.kind === 'VIDEO')
			.map((videoAsset) => ({
				url: protectedAssetUrl(videoAsset.id, 'playback'),
				mimeType: playbackMimeFor(videoAsset),
				originalDownloadUrl: protectedAssetUrl(videoAsset.id),
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
			poster: isPosterUrlSafe(project.poster)
				? responsiveImages.serializeResponsiveImage(project.poster!)
				: undefined,
			webglUrl: parseWebglEntryKey(project.id, project.webglEntryKey ?? '')
				? webglUrl(publicAssetBaseUrl, project.webglEntryKey!)
				: undefined,
			members: project.members.map((m) => ({
				id: m.id,
				name: m.name,
				studentId: m.studentId,
				sortOrder: m.sortOrder,
				userId: m.userId,
			})),
			assets: project.assets.map((a) => {
				if (a.kind === 'IMAGE' || a.kind === 'POSTER' || a.kind === 'THUMBNAIL') {
					return {
						id: a.id,
						kind: a.kind,
						image: responsiveImages.serializeResponsiveImage(a),
						originalName: a.originalName,
						size: Number(a.sizeBytes),
					};
				}
				return {
					id: a.id,
					kind: a.kind,
					url: protectedAssetUrl(a.id, a.kind === 'VIDEO' ? 'playback' : 'original'),
					originalDownloadUrl: a.kind === 'VIDEO' ? protectedAssetUrl(a.id) : undefined,
					playbackUrl: a.kind === 'VIDEO' ? protectedAssetUrl(a.id, 'playback') : undefined,
					playbackStatus: a.kind === 'VIDEO' ? a.playbackStatus : undefined,
					playbackError: a.kind === 'VIDEO' && a.playbackError ? a.playbackError : undefined,
					originalName: a.originalName,
					size: Number(a.sizeBytes),
				};
			}),
		};
	}

	return { protectedAssetUrl, serializeProjectDetail };
}
