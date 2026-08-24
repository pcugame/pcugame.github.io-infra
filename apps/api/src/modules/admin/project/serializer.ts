import type { AdminProjectDetail, AssetKind, Platform, ProjectStatus } from '@pcu/contracts';
import { effectiveIsIncomplete } from '../../../shared/project-completeness.js';
import { IMAGE_RENDITION_PROFILES } from '../../../shared/responsive-image.js';
import { publicObjectUrl } from '../../../shared/public-origin.js';

function canonicalProtectedAssetUrl(base: string, assetId: number, variant: 'original' | 'playback'): string {
	return `${base}/api/assets/${assetId}/download?variant=${variant}`;
}

type SerializableRepresentation = {
	role: string;
	bucket: string;
	objectKey: string;
	mimeType: string;
	state: string;
	sizeBytes: bigint;
	error?: string | null;
	width?: number | null;
	height?: number | null;
};

export type SerializableAsset = {
	id: number;
	kind: AssetKind;
	originalName: string;
	representations?: SerializableRepresentation[];
};

function representation(
	asset: { representations?: SerializableRepresentation[] },
	role: string,
): SerializableRepresentation | undefined {
	return asset.representations?.find((candidate) => candidate.role === role);
}

function playbackMimeFor(asset: SerializableAsset): string {
	return representation(asset, 'PLAYBACK')?.mimeType || 'video/mp4';
}

function playbackStatusFor(asset: SerializableAsset): 'PENDING' | 'READY' | 'FAILED' {
	const state = representation(asset, 'PLAYBACK')?.state;
	if (state === 'READY' || state === 'FAILED') return state;
	return 'PENDING';
}

function imageSourceFor(asset: {
	id?: number;
	representations?: SerializableRepresentation[];
}) {
	const original = asset.representations?.find((candidate) => candidate.role === 'ORIGINAL');
	if (!original || original.state !== 'READY') throw new Error(`Asset ${asset.id ?? 'unknown'} has no READY original representation`);
	return {
		storageKey: original.objectKey,
		width: original.width,
		height: original.height,
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
		kind: AssetKind;
		status: string;
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
	function serializeImage(asset: Parameters<typeof imageSourceFor>[0]) {
		const original = asset.representations?.find((candidate) => candidate.role === 'ORIGINAL');
		if (!publicDelivery || !original || original.state !== 'READY' || original.bucket !== publicDelivery.publicBucket) {
			throw new Error(`Asset ${asset.id ?? 'unknown'} has no READY public ORIGINAL representation`);
		}
		return {
			original: {
				url: publicObjectUrl(publicDelivery.publicAssetOrigin, original.objectKey),
				...(original.width != null ? { width: original.width } : {}),
				...(original.height != null ? { height: original.height } : {}),
			},
			renditions: IMAGE_RENDITION_PROFILES.flatMap((definition) => {
				const rendition = asset.representations?.find(
					(candidate) => candidate.role === definition.profile,
				);
				if (!publicDelivery || !rendition || rendition.state !== 'READY'
					|| rendition.bucket !== publicDelivery.publicBucket || rendition.height == null) return [];
				return [{
					profile: definition.profile,
					url: publicObjectUrl(publicDelivery.publicAssetOrigin, rendition.objectKey),
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
		const completenessPoster = project.poster
			? {
				kind: project.poster.kind,
				status: project.poster.status,
				hasReadyOriginal: representation(project.poster, 'ORIGINAL')?.state === 'READY',
			}
			: null;
		const videos = project.assets
			.filter((a) => a.kind === 'VIDEO')
			.filter((videoAsset) => representation(videoAsset, 'ORIGINAL')?.state === 'READY')
			.map((videoAsset) => {
				const playbackStatus = playbackStatusFor(videoAsset);
				return {
					...(playbackStatus === 'READY'
						? { url: canonicalProtectedAssetUrl(base, videoAsset.id, 'playback') }
						: {}),
					mimeType: playbackMimeFor(videoAsset),
					originalDownloadUrl: canonicalProtectedAssetUrl(base, videoAsset.id, 'original'),
					playbackStatus,
					playbackError: representation(videoAsset, 'PLAYBACK')?.error || undefined,
				};
			});
		const video = videos.find((candidate) => candidate.playbackStatus === 'READY') ?? videos[0] ?? null;

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
			poster: project.poster && project.poster.status === 'READY'
				&& representation(project.poster, 'ORIGINAL')?.state === 'READY'
				? serializeImage(project.poster)
				: undefined,
			webglUrl: canonicalWebglUrl,
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
					const original = representation(a, 'ORIGINAL');
					if (original?.state !== 'READY') return [];
					return [{
						id: a.id,
						kind: a.kind,
						image: serializeImage(a),
						originalName: a.originalName,
						size: Number(original.sizeBytes),
					}];
				}
				// WEBGL is represented by the immutable deployment above. Exposing its
				// source asset as a generic downloadable asset would create a second,
				// independently deletable identity for the same deployment.
				if (a.kind === 'WEBGL') return [];
				const original = representation(a, 'ORIGINAL');
				if (original?.state !== 'READY') return [];
				const playbackStatus = a.kind === 'VIDEO' ? playbackStatusFor(a) : undefined;
				return [{
					id: a.id,
					kind: a.kind,
					url: canonicalProtectedAssetUrl(base, a.id, 'original'),
					originalDownloadUrl: a.kind === 'VIDEO'
						? canonicalProtectedAssetUrl(base, a.id, 'original')
						: undefined,
					playbackUrl: a.kind === 'VIDEO' && playbackStatus === 'READY'
						? canonicalProtectedAssetUrl(base, a.id, 'playback')
						: undefined,
					playbackStatus,
					playbackError: a.kind === 'VIDEO' ? representation(a, 'PLAYBACK')?.error || undefined : undefined,
					originalName: a.originalName,
					size: Number(original.sizeBytes),
				}];
			}),
		};
	}

	return { serializeProjectDetail };
}
