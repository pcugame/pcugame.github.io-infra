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
import { parseWebglEntryKey, webglUrl } from '../webgl/paths.js';

interface PublicPosterRecord {
	kind: AssetKind;
	status: string;
	storageKey: string;
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
		storageKey: string;
		playbackStorageKey?: string | null;
		mimeType: string;
		playbackMimeType?: string;
		playbackStatus?: string;
	}[];
}

export interface PublicServiceDependencies {
	apiPublicUrl: string;
	publicBucket: string;
	presign(bucket: string, key: string): Promise<string>;
	repository: {
		findExhibitionsWithPublishedCounts(): Promise<{
			id: number;
			year: number;
			title: string;
			posterStorageKey: string | null;
			_count: { projects: number };
		}[]>;
		findExhibitionsByYear(year: number): Promise<{ id: number; year: number; title: string }[]>;
		findPublishedProjectsInExhibitions(ids: number[]): Promise<PublicProjectListRecord[]>;
		findExhibitionById(id: number): Promise<{ id: number; year: number; title: string } | null>;
		findExhibitionPosterByStorageKey(key: string): Promise<{ posterStorageKey: string | null } | null>;
		findPublishedProjectById(id: number): Promise<PublicProjectDetailRecord | null>;
		findPublishedProjectBySlug(slug: string, exhibitionIds?: number[]): Promise<PublicProjectDetailRecord | null>;
	};
}

/** Build a public asset URL */
function publicAssetUrl(deps: PublicServiceDependencies, storageKey: string): string {
	return `${deps.apiPublicUrl}/api/assets/public/${storageKey}`;
}

function exhibitionPosterUrl(deps: PublicServiceDependencies, storageKey: string): string {
	return `${deps.apiPublicUrl}/api/public/exhibition-posters/${storageKey}`;
}

function protectedAssetUrl(deps: PublicServiceDependencies, storageKey: string): string {
	return `${deps.apiPublicUrl}/api/assets/protected/${storageKey}`;
}

/** List all years with published project counts */
export async function listYears(deps: PublicServiceDependencies): Promise<PublicYearItem[]> {
	const exhibitions = await deps.repository.findExhibitionsWithPublishedCounts();
	return exhibitions.map((e) => ({
		id: e.id,
		year: e.year,
		title: e.title || undefined,
		projectCount: e._count.projects,
		posterUrl: e.posterStorageKey ? exhibitionPosterUrl(deps, e.posterStorageKey) : undefined,
	}));
}

export async function getExhibitionPosterRedirectUrl(
	deps: PublicServiceDependencies,
	storageKey: string,
): Promise<string> {
	const poster = await deps.repository.findExhibitionPosterByStorageKey(storageKey);
	if (!poster?.posterStorageKey) throw notFound('Poster not found');
	return deps.presign(deps.publicBucket, poster.posterStorageKey);
}

/** List published projects for a given year number (supports multiple exhibitions) */
export async function listProjectsByYear(
	deps: PublicServiceDependencies,
	yearParam: string,
): Promise<PublicYearProjectsResponse> {
	const yearNum = parseInt(yearParam, 10);
	if (isNaN(yearNum)) throw notFound('Year not found');

	const exhibitionRecords = await deps.repository.findExhibitionsByYear(yearNum);
	if (exhibitionRecords.length === 0) throw notFound('Year not found');

	const exhibitionIds = exhibitionRecords.map((e) => e.id);
	const exhibitionMap = new Map(exhibitionRecords.map((e) => [e.id, e]));

	const projects = await deps.repository.findPublishedProjectsInExhibitions(exhibitionIds);

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
			posterUrl: poster && isPosterUrlSafe(poster) ? publicAssetUrl(deps, poster.storageKey) : undefined,
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
	const id = parseInt(idParam, 10);
	if (isNaN(id)) throw notFound('Exhibition not found');

	const exhibition = await deps.repository.findExhibitionById(id);
	if (!exhibition) throw notFound('Exhibition not found');

	const projects = await deps.repository.findPublishedProjectsInExhibitions([id]);

	const items = projects.map((p) => {
		const poster = p.poster;
		return {
			id: p.id,
			slug: p.slug,
			title: p.title,
			summary: p.summary || undefined,
			posterUrl: poster && isPosterUrlSafe(poster) ? publicAssetUrl(deps, poster.storageKey) : undefined,
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
	const yearNum = yearParam ? parseInt(yearParam, 10) : undefined;

	// Try numeric ID lookup first
	const numericId = Number(idOrSlug);
	let project = null;

	if (Number.isInteger(numericId) && numericId > 0) {
		project = await deps.repository.findPublishedProjectById(numericId);
	}

	if (!project) {
		let exhibitionIds: number[] | undefined;
		if (yearNum !== undefined && !isNaN(yearNum)) {
			const exs = await deps.repository.findExhibitionsByYear(yearNum);
			if (exs.length > 0) exhibitionIds = exs.map((e) => e.id);
		}
		project = await deps.repository.findPublishedProjectBySlug(idOrSlug, exhibitionIds);
	}

	if (!project) throw notFound('Project not found');

	const images = project.assets
		.filter((a) => a.kind === 'IMAGE' || a.kind === 'POSTER')
		.map((a) => ({
			id: a.id,
			url: publicAssetUrl(deps, a.storageKey),
			kind: a.kind as 'IMAGE' | 'POSTER',
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
	const poster = project.poster;

	return {
		id: project.id,
		year: project.exhibition.year,
		slug: project.slug,
		title: project.title,
		summary: project.summary || undefined,
		description: project.description || undefined,
		githubUrl: project.githubUrl || undefined,
		platforms: project.platforms ?? [],
		isIncomplete: effectiveIsIncomplete(project.isIncomplete, project.assets, project.poster),
		video,
		videos,
		members: project.members.map((m) => ({
			id: m.id,
			name: m.name,
			studentId: m.studentId,
		})),
		images,
		posterUrl: poster && isPosterUrlSafe(poster) ? publicAssetUrl(deps, poster.storageKey) : undefined,
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
		getExhibitionPosterRedirectUrl: (storageKey: string) => (
			getExhibitionPosterRedirectUrl(deps, storageKey)
		),
		listProjectsByYear: (year: string) => listProjectsByYear(deps, year),
		listProjectsByExhibition: (id: string) => listProjectsByExhibition(deps, id),
		getProjectDetail: (idOrSlug: string, year?: string) => getProjectDetail(deps, idOrSlug, year),
	};
}
