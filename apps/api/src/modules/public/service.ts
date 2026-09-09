import { compareProjectVideos } from '../../shared/project-video-order.js';
import type {
	AssetKind,
	Platform,
	ProjectStatus,
	PublicYearItem,
	PublicYearProjectsResponse,
	PublicExhibitionProjectsResponse,
	PublicProjectDetailResponse,
} from '@pcu/contracts';
import { notFound } from '../../shared/errors.js';
import { isPosterUrlSafe } from '../../shared/poster-validation.js';
import { publicObjectUrl } from '../../shared/public-origin.js';
import { parseWebglEntryKey } from '../webgl/paths.js';
import {
	serializePublicImage,
	type PublicImageRepresentationRecord,
} from './image-serialization.js';

interface PublicPosterRecord {
	kind: AssetKind;
	status: string;
	isPublic: boolean;
	storageKey: string | null;
	width?: number | null;
	height?: number | null;
	card480Height?: number | null;
	display960Height?: number | null;
	representations?: PublicImageRepresentationRecord[];
}

interface PublicProjectListRecord {
	id: number;
	slug: string;
	title: string;
	summary: string;
	exhibitionId: number;
	poster: PublicPosterRecord | null;
	members: { name: string; studentId: string }[];
}

interface PublicProjectDetailRecord extends PublicProjectListRecord {
	description: string;
	githubUrl?: string;
	platforms?: Platform[];
	isIncomplete: boolean;
	status: ProjectStatus;
	webglEntryKey?: string | null;
	currentWebglDeploymentId?: string | null;
	currentWebglDeployment?: {
		id: string;
		publicBucket: string;
		publicPrefix: string;
		entryObjectKey: string;
		state: string;
	} | null;
	exhibition: { year: number };
	members: { id: number; name: string; studentId: string }[];
	assets: {
		id: number;
		videoSortOrder?: number | null;
		createdAt?: Date;
		originalName?: string;
		kind: AssetKind;
		isPublic: boolean;
		storageKey: string | null;
		width?: number | null;
		height?: number | null;
		card480Height?: number | null;
		display960Height?: number | null;
		playbackStorageKey?: string | null;
		mimeType: string;
		playbackMimeType?: string;
		playbackStatus?: string;
		playbackError?: string;
		representations?: Array<PublicImageRepresentationRecord & { mimeType?: string; error?: string | null }>;
	}[];
}

export interface PublicServiceDependencies {
	apiPublicUrl: string;
	publicAssetOrigin?: string;
	publicBucket?: string;
	logger?: { warn(record: Record<string, unknown>, message: string): void };
	repository: {
		findExhibitionsWithPublishedCounts(): Promise<{
			id: number;
			year: number;
			title: string;
			posterStorageKey: string | null;
			posterWidth?: number | null;
			posterHeight?: number | null;
			posterCard480Height?: number | null;
			posterDisplay960Height?: number | null;
			posterAssetId?: number | null;
			poster?: PublicPosterRecord | null;
			_count: { projects: number };
		}[]>;
		findExhibitionsByYear(year: number): Promise<{ id: number; year: number; title: string }[]>;
		findPublishedProjectsInExhibitions(ids: number[]): Promise<PublicProjectListRecord[]>;
		findExhibitionById(id: number): Promise<{ id: number; year: number; title: string } | null>;
		findPublishedProjectById(id: number): Promise<PublicProjectDetailRecord | null>;
		findPublishedProjectBySlug(slug: string, exhibitionIds?: number[]): Promise<PublicProjectDetailRecord | null>;
		recordMigrationMetric?(
			name: string,
			scope: string,
			details?: Record<string, unknown>,
		): Promise<void>;
	};
}

function protectedAssetUrl(deps: PublicServiceDependencies, assetId: number, variant: string): string {
	return `${deps.apiPublicUrl.replace(/\/$/, '')}/api/assets/${assetId}/download?variant=${variant}`;
}

function isPublicPoster(poster: PublicPosterRecord | null): poster is PublicPosterRecord {
	return poster?.isPublic === true && (
		(poster.representations?.length ?? 0) > 0
		|| (poster.storageKey != null && isPosterUrlSafe({ ...poster, storageKey: poster.storageKey }))
	);
}

function imageOptions(deps: PublicServiceDependencies, scope: string, details: Record<string, unknown>) {
	return {
		publicAssetOrigin: deps.publicAssetOrigin ?? deps.apiPublicUrl,
		publicBucket: deps.publicBucket ?? 'pcu-public',
		onLegacyFallback: async () => {
			await deps.repository.recordMigrationMetric?.('public_image_legacy_fallback', scope, details);
			deps.logger?.warn(details, 'Public response used legacy image representation fallback');
		},
	};
}

/** List all years with published project counts */
export async function listYears(deps: PublicServiceDependencies): Promise<PublicYearItem[]> {
	const exhibitions = await deps.repository.findExhibitionsWithPublishedCounts();
	return Promise.all(exhibitions.map(async (e) => ({
		id: e.id,
		year: e.year,
		title: e.title || undefined,
		projectCount: e._count.projects,
		poster: e.posterAssetId != null
			? (e.poster ? await serializePublicImage(e.poster, imageOptions(deps, 'year-poster', { exhibitionId: e.id })) : undefined)
			: (e.posterStorageKey ? await serializePublicImage({
				storageKey: e.posterStorageKey,
				width: e.posterWidth,
				height: e.posterHeight,
				card480Height: e.posterCard480Height,
				display960Height: e.posterDisplay960Height,
			}, imageOptions(deps, 'year-poster', { exhibitionId: e.id })) : undefined),
	})));
}

/** List published projects for a given year number (supports multiple exhibitions) */
export async function listProjectsByYear(
	deps: PublicServiceDependencies,
	yearParam: string,
): Promise<PublicYearProjectsResponse> {
	const yearNum = Number(yearParam);
	if (!/^\d{4}$/.test(yearParam) || !Number.isSafeInteger(yearNum)) {
		throw notFound('Year not found');
	}

	const exhibitionRecords = await deps.repository.findExhibitionsByYear(yearNum);
	if (exhibitionRecords.length === 0) throw notFound('Year not found');

	const exhibitionIds = exhibitionRecords.map((e) => e.id);
	const exhibitionMap = new Map(exhibitionRecords.map((e) => [e.id, e]));

	const projects = await deps.repository.findPublishedProjectsInExhibitions(exhibitionIds);

	const exhibitions = exhibitionRecords.map((e) => ({
		id: e.id,
		title: e.title || `${yearNum} 전시`,
	}));

	const items = await Promise.all(projects.map(async (p) => {
		const ex = exhibitionMap.get(p.exhibitionId);
		const poster = p.poster;
		return {
			id: p.id,
			slug: p.slug,
			title: p.title,
			summary: p.summary || undefined,
			poster: isPublicPoster(poster)
				? await serializePublicImage(poster, imageOptions(deps, 'project-poster', { projectId: p.id }))
				: undefined,
			members: p.members.map((m) => ({ name: m.name, studentId: m.studentId })),
			exhibitionId: p.exhibitionId,
			exhibitionTitle: ex?.title || `${yearNum} 전시`,
		};
	}));

	return { year: yearNum, exhibitions, items, empty: items.length === 0 };
}

/** List published projects for a single exhibition by ID */
export async function listProjectsByExhibition(
	deps: PublicServiceDependencies,
	idParam: string,
): Promise<PublicExhibitionProjectsResponse> {
	const id = Number(idParam);
	if (!/^[1-9]\d*$/.test(idParam) || !Number.isSafeInteger(id)) {
		throw notFound('Exhibition not found');
	}

	const exhibition = await deps.repository.findExhibitionById(id);
	if (!exhibition) throw notFound('Exhibition not found');

	const projects = await deps.repository.findPublishedProjectsInExhibitions([id]);
	const items = await Promise.all(projects.map(async (p) => {
		const poster = p.poster;
		return {
			id: p.id,
			slug: p.slug,
			title: p.title,
			summary: p.summary || undefined,
			poster: isPublicPoster(poster)
				? await serializePublicImage(poster, imageOptions(deps, 'project-poster', { projectId: p.id }))
				: undefined,
			members: p.members.map((m) => ({ name: m.name, studentId: m.studentId })),
			exhibitionId: p.exhibitionId,
			exhibitionTitle: exhibition.title || `${exhibition.year} 전시`,
		};
	}));

	return {
		exhibition: {
			id: exhibition.id,
			year: exhibition.year,
			title: exhibition.title || `${exhibition.year} 전시`,
		},
		items,
		empty: items.length === 0,
	};
}

/** Get a single published project by ID or slug */
export async function getProjectDetail(
	deps: PublicServiceDependencies,
	idOrSlug: string,
	yearParam?: string,
): Promise<PublicProjectDetailResponse> {
	const yearNum = yearParam === undefined ? undefined : Number(yearParam);
	if (
		yearParam !== undefined
		&& (!/^\d{4}$/.test(yearParam) || !Number.isSafeInteger(yearNum))
	) {
		throw notFound('Year not found');
	}

	// Try numeric ID lookup first
	const numericId = Number(idOrSlug);
	let project = null;

	if (
		/^[1-9]\d*$/.test(idOrSlug)
		&& Number.isSafeInteger(numericId)
	) {
		project = await deps.repository.findPublishedProjectById(numericId);
	}

	if (!project) {
		let exhibitionIds: number[] | undefined;
		if (yearNum !== undefined) {
			const exs = await deps.repository.findExhibitionsByYear(yearNum);
			if (exs.length > 0) exhibitionIds = exs.map((e) => e.id);
		}
		project = await deps.repository.findPublishedProjectBySlug(idOrSlug, exhibitionIds);
	}

	if (!project) throw notFound('Project not found');
	// The expand database knows DRAFT for future submission aggregates, while
	// Phase 1 public contracts intentionally remain PUBLISHED/ARCHIVED only.
	if (project.status !== 'PUBLISHED' && project.status !== 'ARCHIVED') throw notFound('Project not found');
	const images = (await Promise.all(project.assets
		.filter((a) => a.isPublic === true && (a.kind === 'IMAGE' || a.kind === 'POSTER'))
		.map(async (a) => {
			const image = await serializePublicImage(a, imageOptions(deps, 'project-image', { assetId: a.id }));
			return image ? { id: a.id, kind: a.kind as 'IMAGE' | 'POSTER', image } : undefined;
		}))).filter((image): image is NonNullable<typeof image> => image !== undefined);

	const gameAssets = project.assets.filter((a) => a.kind === 'GAME');
	const gameAsset = gameAssets.length > 0 ? gameAssets[gameAssets.length - 1] : undefined;

	const videos = project.assets.filter((asset) => asset.kind === 'VIDEO' && ((asset.representations?.length ?? 0) > 0
			? asset.representations?.some((rep) => rep.role === 'ORIGINAL' && rep.state === 'READY') : !!asset.storageKey))
		.sort(compareProjectVideos).flatMap((videoAsset, index) => {
		const canonical = videoAsset.representations ?? [];
		const playback = canonical.find((representation) => representation.role === 'PLAYBACK');
		const playbackStatus = canonical.length > 0
			? playback?.state === 'READY' ? 'READY' as const : playback?.state === 'FAILED' ? 'FAILED' as const : 'PENDING' as const
			: videoAsset.playbackStatus === 'READY' ? 'READY' as const : videoAsset.playbackStatus === 'FAILED' ? 'FAILED' as const : 'PENDING' as const;
		return [{
			assetId: videoAsset.id,
			sortOrder: videoAsset.videoSortOrder ?? null,
			role: index === 0 ? 'MAIN' as const : 'ADDITIONAL' as const,
			...(playbackStatus === 'READY' ? { url: protectedAssetUrl(deps, videoAsset.id, 'playback') } : {}),
			mimeType: playback?.mimeType || videoAsset.playbackMimeType || videoAsset.mimeType || 'video/mp4',
			originalDownloadUrl: protectedAssetUrl(deps, videoAsset.id, 'original'),
			playbackStatus,
			...((playback?.error || videoAsset.playbackError) ? { playbackError: playback?.error || videoAsset.playbackError } : {}),
		}];
	});
	const video = videos[0] ?? null;
	const poster = isPublicPoster(project.poster) ? project.poster : null;
	const serializedPoster = poster
		? await serializePublicImage(poster, imageOptions(deps, 'project-poster', { projectId: project.id }))
		: undefined;
	const validKinds = new Set(project.assets.map((asset) => asset.kind));
	const isIncomplete = project.isIncomplete !== false
		|| !gameAsset || !videos.some((candidate) => candidate.playbackStatus === 'READY') || !serializedPoster;
	let webglEntryUrl: string | undefined;
	if (project.currentWebglDeploymentId != null) {
		const deployment = project.currentWebglDeployment;
		if (deployment?.id === project.currentWebglDeploymentId
			&& deployment.state === 'READY'
			&& deployment.publicBucket === (deps.publicBucket ?? 'pcu-public')
			&& deployment.entryObjectKey.startsWith(deployment.publicPrefix)) {
			webglEntryUrl = publicObjectUrl(deps.publicAssetOrigin ?? deps.apiPublicUrl, deployment.entryObjectKey);
		}
	} else if (project.webglEntryKey && parseWebglEntryKey(project.id, project.webglEntryKey)) {
		await deps.repository.recordMigrationMetric?.('public_webgl_legacy_fallback', 'project-response', { projectId: project.id });
		deps.logger?.warn({ projectId: project.id }, 'Public response used legacy WebGL deployment fallback');
		webglEntryUrl = publicObjectUrl(deps.publicAssetOrigin ?? deps.apiPublicUrl, project.webglEntryKey);
	}

	return {
		id: project.id,
		year: project.exhibition.year,
		slug: project.slug,
		title: project.title,
		summary: project.summary || undefined,
		description: project.description || undefined,
		githubUrl: project.githubUrl || undefined,
		platforms: project.platforms ?? [],
		isIncomplete: isIncomplete || !validKinds.has('GAME'),
		video,
		videos,
		attachments: project.assets.flatMap((asset) => {
			if (asset.kind !== 'DOCUMENT' && asset.kind !== 'ATTACHMENT') return [];
			const original = asset.representations?.find((rep) => rep.role === 'ORIGINAL' && rep.state === 'READY');
			return original ? [{ assetId: asset.id, kind: asset.kind, originalName: asset.originalName ?? `material-${asset.id}`, mimeType: original.mimeType ?? 'application/octet-stream', sizeBytes: Number(original.sizeBytes ?? 0), downloadUrl: protectedAssetUrl(deps, asset.id, 'original') }] : [];
		}),

		members: project.members.map((m) => ({
			id: m.id,
			name: m.name,
			studentId: m.studentId,
		})),
		images,
		poster: serializedPoster,
		gameDownloadUrl: gameAsset
			? protectedAssetUrl(deps, gameAsset.id, 'original')
			: undefined,
		webglUrl: webglEntryUrl,
		status: project.status,
	};
}

export function createPublicService(deps: PublicServiceDependencies) {
	return {
		listYears: () => listYears(deps),
		listProjectsByYear: (year: string) => listProjectsByYear(deps, year),
		listProjectsByExhibition: (id: string) => listProjectsByExhibition(deps, id),
		getProjectDetail: (idOrSlug: string, year?: string) => getProjectDetail(deps, idOrSlug, year),
	};
}
