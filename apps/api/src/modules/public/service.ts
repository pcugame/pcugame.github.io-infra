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
import { publicObjectUrl } from '../../shared/public-origin.js';
import {
	serializePublicImage,
	type PublicImageRepresentationRecord,
} from './image-serialization.js';

interface PublicPosterRecord {
	kind: AssetKind;
	status: string;
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
		kind: AssetKind;
		representations?: PublicImageRepresentationRecord[];
	}[];
}

export interface PublicServiceDependencies {
	apiPublicUrl: string;
	publicAssetOrigin?: string;
	publicBucket?: string;
	repository: {
		findExhibitionsWithPublishedCounts(): Promise<{
			id: number;
			year: number;
			title: string;
			posterAssetId?: number | null;
			poster?: PublicPosterRecord | null;
			_count: { projects: number };
		}[]>;
		findExhibitionsByYear(year: number): Promise<{ id: number; year: number; title: string }[]>;
		findPublishedProjectsInExhibitions(ids: number[]): Promise<PublicProjectListRecord[]>;
		findExhibitionById(id: number): Promise<{ id: number; year: number; title: string } | null>;
		findPublishedProjectById(id: number): Promise<PublicProjectDetailRecord | null>;
		findPublishedProjectBySlug(slug: string, exhibitionIds?: number[]): Promise<PublicProjectDetailRecord | null>;
	};
}

function protectedAssetUrl(deps: PublicServiceDependencies, assetId: number, variant: string): string {
	return `${deps.apiPublicUrl.replace(/\/$/, '')}/api/assets/${assetId}/download?variant=${variant}`;
}

function isPublicPoster(poster: PublicPosterRecord | null, bucket: string): poster is PublicPosterRecord {
	return poster?.status === 'READY'
		&& poster.representations?.some((representation) => (
			representation.role === 'ORIGINAL'
			&& representation.state === 'READY'
			&& representation.bucket === bucket
		)) === true;
}

function imageOptions(deps: PublicServiceDependencies) {
	return {
		publicAssetOrigin: deps.publicAssetOrigin ?? deps.apiPublicUrl,
		publicBucket: deps.publicBucket ?? 'pcu-public',
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
		poster: e.posterAssetId != null && e.poster && isPublicPoster(e.poster, deps.publicBucket ?? 'pcu-public')
			? await serializePublicImage(e.poster, imageOptions(deps))
			: undefined,
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
			poster: isPublicPoster(poster, deps.publicBucket ?? 'pcu-public')
				? await serializePublicImage(poster, imageOptions(deps))
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
			poster: isPublicPoster(poster, deps.publicBucket ?? 'pcu-public')
				? await serializePublicImage(poster, imageOptions(deps))
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
	const images = (await Promise.all(project.assets
		.filter((a) => a.kind === 'IMAGE' || a.kind === 'POSTER')
		.map(async (a) => {
			const image = await serializePublicImage(a, imageOptions(deps));
			return image ? { id: a.id, kind: a.kind as 'IMAGE' | 'POSTER', image } : undefined;
		}))).filter((image): image is NonNullable<typeof image> => image !== undefined);

	const gameAssets = project.assets.filter((asset) => asset.kind === 'GAME'
		&& asset.representations?.some((representation) => (
			representation.role === 'ORIGINAL' && representation.state === 'READY'
		)));
	const gameAsset = gameAssets.length > 0 ? gameAssets[gameAssets.length - 1] : undefined;

	const videos = project.assets.flatMap((videoAsset) => {
		if (videoAsset.kind !== 'VIDEO') return [];
		const original = videoAsset.representations?.find((representation) => representation.role === 'ORIGINAL');
		const playback = videoAsset.representations?.find((representation) => representation.role === 'PLAYBACK');
		if (original?.state !== 'READY') return [];
		const playbackStatus = playback?.state === 'READY'
			? 'READY' as const
			: playback?.state === 'FAILED' ? 'FAILED' as const : 'PENDING' as const;
		return [{
			...(playbackStatus === 'READY'
				? { url: protectedAssetUrl(deps, videoAsset.id, 'playback') }
				: {}),
			mimeType: playback?.mimeType || original.mimeType || 'video/mp4',
			originalDownloadUrl: protectedAssetUrl(deps, videoAsset.id, 'original'),
			playbackStatus,
			...(playback?.error ? { playbackError: playback.error } : {}),
		}];
	});
	const video = videos.find((candidate) => candidate.playbackStatus === 'READY') ?? videos[0] ?? null;
	const poster = isPublicPoster(project.poster, deps.publicBucket ?? 'pcu-public') ? project.poster : null;
	const serializedPoster = poster
		? await serializePublicImage(poster, imageOptions(deps))
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
	}

	if (project.status === 'DRAFT') {
		throw new Error('DRAFT project escaped the public repository boundary');
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
