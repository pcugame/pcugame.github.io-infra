import type { AdminProjectDetail, AssetKind, AssetPlaybackStatus, Platform, ProjectStatus } from '@pcu/contracts';
import { isPosterUrlSafe } from '../../../shared/poster-validation.js';
import { effectiveIsIncomplete } from '../../../shared/project-completeness.js';
import {
	createResponsiveImageSerializer,
	IMAGE_RENDITION_PROFILES,
} from '../../../shared/responsive-image.js';
import { publicObjectUrl } from '../../../shared/public-origin.js';
import { parseWebglEntryKey, webglUrl } from '../../webgl/paths.js';

function protectedAssetUrlFor(base: string, storageKey: string): string {
	return `${base}/api/assets/protected/${storageKey}`;
}

function canonicalProtectedAssetUrl(base: string, assetId: number, variant: 'original' | 'playback'): string {
	return `${base}/api/assets/${assetId}/download?variant=${variant}`;
}

type SerializableRepresentation = {
	role: string;
	objectKey: string;
	mimeType: string;
	width?: number | null;
	height?: number | null;
};

export type SerializableAsset = {
	id: number;
	kind: AssetKind;
	storageKey: string | null;
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
	representations?: SerializableRepresentation[];
};

function representation(
	asset: { representations?: SerializableRepresentation[] },
	role: string,
): SerializableRepresentation | undefined {
	return asset.representations?.find((candidate) => candidate.role === role);
}

function playbackMimeFor(asset: SerializableAsset): string {
	return representation(asset, 'PLAYBACK')?.mimeType
		?? (asset.kind === 'VIDEO' && asset.playbackStorageKey
			? asset.playbackMimeType || 'video/mp4'
			: asset.mimeType || 'video/mp4');
}

function imageSourceFor(asset: {
	id?: number;
	storageKey: string | null;
	width?: number | null;
	height?: number | null;
	card480Height?: number | null;
	display960Height?: number | null;
	representations?: SerializableRepresentation[];
}) {
	const original = asset.representations?.find((candidate) => candidate.role === 'ORIGINAL');
	const originalKey = original?.objectKey ?? asset.storageKey;
	if (!originalKey) throw new Error(`Asset ${asset.id ?? 'unknown'} has no original representation`);
	return {
		storageKey: originalKey,
		width: original?.width ?? asset.width,
		height: original?.height ?? asset.height,
		card480Height: asset.representations?.find((candidate) => candidate.role === 'CARD_480')?.height
			?? asset.card480Height,
		display960Height: asset.representations?.find((candidate) => candidate.role === 'DISPLAY_960')?.height
			?? asset.display960Height,
	};
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
	currentWebglDeploymentId?: string | null;
	currentWebglDeployment?: {
		id: string;
		projectId: number;
		publicBucket: string;
		publicPrefix: string;
		entryObjectKey: string;
		state: string;
		createdAt: Date;
	} | null;
	poster: {
		id?: number;
		storageKey: string | null;
		kind: AssetKind;
		status: string;
		width?: number | null;
		height?: number | null;
		card480Height?: number | null;
		display960Height?: number | null;
		representations?: SerializableRepresentation[];
	} | null;
	members: { id: number; name: string; studentId: string; sortOrder: number; userId: number | null }[];
	assets: SerializableAsset[];
};

export function createProjectSerializer(
	baseUrl: string,
	publicDelivery?: { publicAssetOrigin: string; publicBucket: string },
) {
	const base = baseUrl.replace(/\/$/, '');
	const protectedAssetUrl = (storageKey: string) => protectedAssetUrlFor(base, storageKey);
	const responsiveImages = createResponsiveImageSerializer(base);
	function serializeImage(asset: Parameters<typeof imageSourceFor>[0]) {
		const original = asset.representations?.find((candidate) => candidate.role === 'ORIGINAL');
		if (!original) return responsiveImages.serializeResponsiveImage(imageSourceFor(asset));
		return {
			original: {
				url: responsiveImages.publicImageUrl(original.objectKey),
				...(original.width != null ? { width: original.width } : {}),
				...(original.height != null ? { height: original.height } : {}),
			},
			renditions: IMAGE_RENDITION_PROFILES.flatMap((definition) => {
				const rendition = asset.representations?.find(
					(candidate) => candidate.role === definition.profile,
				);
				if (!rendition || rendition.height == null) return [];
				return [{
					profile: definition.profile,
					url: responsiveImages.publicImageUrl(rendition.objectKey),
					width: rendition.width ?? definition.width,
					height: rendition.height,
				}];
			}),
		};
	}

	function serializeProjectDetail(project: SerializableProject): AdminProjectDetail {
		const deployment = project.currentWebglDeploymentId != null
			&& project.currentWebglDeployment?.id === project.currentWebglDeploymentId
			&& project.currentWebglDeployment.projectId === project.id
			&& project.currentWebglDeployment.state === 'READY'
			&& project.currentWebglDeployment.entryObjectKey.startsWith(
				project.currentWebglDeployment.publicPrefix,
			)
			&& publicDelivery?.publicBucket === project.currentWebglDeployment.publicBucket
			? project.currentWebglDeployment
			: undefined;
		const canonicalWebglUrl = deployment
			? publicObjectUrl(publicDelivery!.publicAssetOrigin, deployment.entryObjectKey)
			: undefined;
		const legacyWebglUrl = project.currentWebglDeploymentId == null
			&& parseWebglEntryKey(project.id, project.webglEntryKey ?? '')
			? webglUrl(base, project.id)
			: undefined;
		const completenessPoster = project.poster
			? {
				kind: project.poster.kind,
				status: project.poster.status,
				storageKey: representation(project.poster, 'ORIGINAL')?.objectKey
					?? project.poster.storageKey
					?? '',
			}
			: null;
		const videos = project.assets
			.filter((a) => a.kind === 'VIDEO')
			.map((videoAsset) => ({
				url: canonicalProtectedAssetUrl(base, videoAsset.id, 'playback'),
				mimeType: playbackMimeFor(videoAsset),
				originalDownloadUrl: canonicalProtectedAssetUrl(base, videoAsset.id, 'original'),
				playbackStatus: representation(videoAsset, 'PLAYBACK') ? 'READY' : videoAsset.playbackStatus,
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
			isIncomplete: effectiveIsIncomplete(project.isIncomplete, project.assets, completenessPoster),
			video,
			videos,
			status: project.status,
			sortOrder: project.sortOrder,
			posterAssetId: project.posterAssetId ?? undefined,
			poster: project.poster && isPosterUrlSafe({
				...project.poster,
				storageKey: imageSourceFor(project.poster).storageKey,
			})
				? serializeImage(project.poster)
				: undefined,
			webglUrl: canonicalWebglUrl ?? legacyWebglUrl,
			webglDeployment: deployment && canonicalWebglUrl
				? {
					id: deployment.id,
					url: canonicalWebglUrl,
					createdAt: deployment.createdAt.toISOString(),
				}
				: undefined,
			members: project.members.map((m) => ({
				id: m.id,
				name: m.name,
				studentId: m.studentId,
				sortOrder: m.sortOrder,
				userId: m.userId,
			})),
			assets: project.assets.flatMap<AdminProjectDetail['assets'][number]>((a) => {
				if (a.kind === 'IMAGE' || a.kind === 'POSTER' || a.kind === 'THUMBNAIL') {
					return [{
						id: a.id,
						kind: a.kind,
						image: serializeImage(a),
						originalName: a.originalName,
						size: Number(a.sizeBytes),
					}];
				}
				// WEBGL is represented by the immutable deployment above. Exposing its
				// source asset as a generic downloadable asset would create a second,
				// independently deletable identity for the same deployment.
				if (a.kind === 'WEBGL') return [];
				return [{
					id: a.id,
					kind: a.kind,
					url: canonicalProtectedAssetUrl(base, a.id, 'original'),
					originalDownloadUrl: a.kind === 'VIDEO'
						? canonicalProtectedAssetUrl(base, a.id, 'original')
						: undefined,
					playbackUrl: a.kind === 'VIDEO'
						? canonicalProtectedAssetUrl(base, a.id, 'playback')
						: undefined,
					playbackStatus: a.kind === 'VIDEO' && representation(a, 'PLAYBACK')
						? 'READY'
						: a.kind === 'VIDEO' ? a.playbackStatus : undefined,
					playbackError: a.kind === 'VIDEO' && a.playbackError ? a.playbackError : undefined,
					originalName: a.originalName,
					size: Number(a.sizeBytes),
				}];
			}),
		};
	}

	return { protectedAssetUrl, serializeProjectDetail };
}
