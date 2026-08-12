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
import { effectiveIsIncomplete } from '../../shared/project-completeness.js';
import {
	createResponsiveImageSerializer,
} from '../../shared/responsive-image.js';
import { parseWebglEntryKey, webglUrl } from '../webgl/paths.js';

interface PublicPosterRecord {
	kind: AssetKind;
	status: string;
	isPublic: boolean;
	storageKey: string;
	width?: number | null;
	height?: number | null;
	card480Height?: number | null;
	display960Height?: number | null;
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
	webglEntryKey?: string;
	exhibition: { year: number };
	members: { id: number; name: string; studentId: string }[];
	assets: {
		id: number;
		kind: AssetKind;
		isPublic: boolean;
		storageKey: string;
		width?: number | null;
		height?: number | null;
		card480Height?: number | null;
		display960Height?: number | null;
		playbackStorageKey?: string | null;
		mimeType: string;
		playbackMimeType?: string;
		playbackStatus?: string;
	}[];
}

export interface PublicServiceDependencies {
	apiPublicUrl: string;
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
			_count: { projects: number };
		}[]>;
		findExhibitionsByYear(year: number): Promise<{ id: number; year: number; title: string }[]>;
		findPublishedProjectsInExhibitions(ids: number[]): Promise<PublicProjectListRecord[]>;
		findExhibitionById(id: number): Promise<{ id: number; year: number; title: string } | null>;
		findPublishedProjectById(id: number): Promise<PublicProjectDetailRecord | null>;
		findPublishedProjectBySlug(slug: string, exhibitionIds?: number[]): Promise<PublicProjectDetailRecord | null>;
	};
}

function protectedAssetUrl(deps: PublicServiceDependencies, storageKey: string): string {
	return `${deps.apiPublicUrl}/api/assets/protected/${storageKey}`;
}

function isPublicPoster(poster: PublicPosterRecord | null): poster is PublicPosterRecord {
	return poster?.isPublic === true && isPosterUrlSafe(poster);
}

/** List all years with published project counts */
export async function listYears(deps: PublicServiceDependencies): Promise<PublicYearItem[]> {
	const exhibitions = await deps.repository.findExhibitionsWithPublishedCounts();
	const responsiveImages = createResponsiveImageSerializer(deps.apiPublicUrl);
	return exhibitions.map((e) => ({
		id: e.id,
		year: e.year,
		title: e.title || undefined,
		projectCount: e._count.projects,
		poster: e.posterStorageKey ? responsiveImages.serializeResponsiveImage({
			storageKey: e.posterStorageKey,
			width: e.posterWidth,
			height: e.posterHeight,
			card480Height: e.posterCard480Height,
			display960Height: e.posterDisplay960Height,
		}) : undefined,
	}));
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
	const responsiveImages = createResponsiveImageSerializer(deps.apiPublicUrl);

	const exhibitions = exhibitionRecords.map((e) => ({
		id: e.id,
		title: e.title || `${yearNum} 전시`,
	}));

	const items = projects.map((p) => {
		const ex = exhibitionMap.get(p.exhibitionId);
		const poster = p.poster;
		return {
			id: p.id,
			slug: p.slug,
			title: p.title,
			summary: p.summary || undefined,
			poster: isPublicPoster(poster)
				? responsiveImages.serializeResponsiveImage(poster)
				: undefined,
			members: p.members.map((m) => ({ name: m.name, studentId: m.studentId })),
			exhibitionId: p.exhibitionId,
			exhibitionTitle: ex?.title || `${yearNum} 전시`,
		};
	});

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
	const responsiveImages = createResponsiveImageSerializer(deps.apiPublicUrl);

	const items = projects.map((p) => {
		const poster = p.poster;
		return {
			id: p.id,
			slug: p.slug,
			title: p.title,
			summary: p.summary || undefined,
			poster: isPublicPoster(poster)
				? responsiveImages.serializeResponsiveImage(poster)
				: undefined,
			members: p.members.map((m) => ({ name: m.name, studentId: m.studentId })),
			exhibitionId: p.exhibitionId,
			exhibitionTitle: exhibition.title || `${exhibition.year} 전시`,
		};
	});

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
	const responsiveImages = createResponsiveImageSerializer(deps.apiPublicUrl);

	const images = project.assets
		.filter((a) => a.isPublic === true && (a.kind === 'IMAGE' || a.kind === 'POSTER'))
		.map((a) => ({
			id: a.id,
			kind: a.kind as 'IMAGE' | 'POSTER',
			image: responsiveImages.serializeResponsiveImage(a),
		}));

	const gameAssets = project.assets.filter((a) => a.kind === 'GAME');
	const gameAsset = gameAssets.length > 0 ? gameAssets[gameAssets.length - 1] : undefined;

	const videos = project.assets
		.filter((a) => a.kind === 'VIDEO' && a.playbackStatus === 'READY')
		.map((videoAsset) => ({
			url: protectedAssetUrl(deps, videoAsset.playbackStorageKey ?? videoAsset.storageKey),
			mimeType: videoAsset.playbackStorageKey
				? videoAsset.playbackMimeType || 'video/mp4'
				: videoAsset.mimeType || 'video/mp4',
		}));
	const video = videos[0] ?? null;
	const poster = isPublicPoster(project.poster) ? project.poster : null;

	return {
		id: project.id,
		year: project.exhibition.year,
		slug: project.slug,
		title: project.title,
		summary: project.summary || undefined,
		description: project.description || undefined,
		githubUrl: project.githubUrl || undefined,
		platforms: project.platforms ?? [],
		isIncomplete: effectiveIsIncomplete(project.isIncomplete, project.assets, poster),
		video,
		videos,
		members: project.members.map((m) => ({
			id: m.id,
			name: m.name,
			studentId: m.studentId,
		})),
		images,
		poster: poster
			? responsiveImages.serializeResponsiveImage(poster)
			: undefined,
		gameDownloadUrl: gameAsset
			? protectedAssetUrl(deps, gameAsset.storageKey)
			: undefined,
		webglUrl: project.webglEntryKey && parseWebglEntryKey(project.id, project.webglEntryKey)
			? webglUrl(deps.apiPublicUrl, project.id)
			: undefined,
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
