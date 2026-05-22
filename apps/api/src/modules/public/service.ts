import type {
	PublicYearItem,
	PublicYearProjectsResponse,
	PublicExhibitionProjectsResponse,
	PublicProjectDetailResponse,
} from '@pcu/contracts';
import { env } from '../../config/env.js';
import { getPresignedUrl } from '../../lib/storage.js';
import { notFound } from '../../shared/errors.js';
import { isPosterUrlSafe } from '../../shared/poster-validation.js';
import { effectiveIsIncomplete } from '../../shared/project-completeness.js';
import * as repo from './repository.js';

/** Build a public asset URL */
function publicAssetUrl(storageKey: string): string {
	return `${env().API_PUBLIC_URL}/api/assets/public/${storageKey}`;
}

function exhibitionPosterUrl(storageKey: string): string {
	return `${env().API_PUBLIC_URL}/api/public/exhibition-posters/${storageKey}`;
}

function protectedAssetUrl(storageKey: string): string {
	return `${env().API_PUBLIC_URL}/api/assets/protected/${storageKey}`;
}

/** List all years with published project counts */
export async function listYears(): Promise<PublicYearItem[]> {
	const exhibitions = await repo.findExhibitionsWithPublishedCounts();
	return exhibitions.map((e) => ({
		id: e.id,
		year: e.year,
		title: e.title || undefined,
		projectCount: e._count.projects,
		posterUrl: e.posterStorageKey ? exhibitionPosterUrl(e.posterStorageKey) : undefined,
	}));
}

export async function getExhibitionPosterRedirectUrl(storageKey: string): Promise<string> {
	const poster = await repo.findExhibitionPosterByStorageKey(storageKey);
	if (!poster?.posterStorageKey) throw notFound('Poster not found');
	return getPresignedUrl(env().S3_BUCKET_PUBLIC, poster.posterStorageKey);
}

/** List published projects for a given year number (supports multiple exhibitions) */
export async function listProjectsByYear(yearParam: string): Promise<PublicYearProjectsResponse> {
	const yearNum = parseInt(yearParam, 10);
	if (isNaN(yearNum)) throw notFound('Year not found');

	const exhibitionRecords = await repo.findExhibitionsByYear(yearNum);
	if (exhibitionRecords.length === 0) throw notFound('Year not found');

	const exhibitionIds = exhibitionRecords.map((e) => e.id);
	const exhibitionMap = new Map(exhibitionRecords.map((e) => [e.id, e]));

	const projects = await repo.findPublishedProjectsInExhibitions(exhibitionIds);

	const exhibitions = exhibitionRecords.map((e) => ({
		id: e.id,
		title: e.title || `${yearNum} 전시`,
	}));

	const items = projects.map((p) => {
		const ex = exhibitionMap.get(p.exhibitionId);
		return {
			id: p.id,
			slug: p.slug,
			title: p.title,
			summary: p.summary || undefined,
			posterUrl: isPosterUrlSafe(p.poster) ? publicAssetUrl(p.poster!.storageKey) : undefined,
			members: p.members.map((m) => ({ name: m.name, studentId: m.studentId })),
			exhibitionId: p.exhibitionId,
			exhibitionTitle: ex?.title || `${yearNum} 전시`,
		};
	});

	return { year: yearNum, exhibitions, items, empty: items.length === 0 };
}

/** List published projects for a single exhibition by ID */
export async function listProjectsByExhibition(idParam: string): Promise<PublicExhibitionProjectsResponse> {
	const id = parseInt(idParam, 10);
	if (isNaN(id)) throw notFound('Exhibition not found');

	const exhibition = await repo.findExhibitionById(id);
	if (!exhibition) throw notFound('Exhibition not found');

	const projects = await repo.findPublishedProjectsInExhibitions([id]);

	const items = projects.map((p) => ({
		id: p.id,
		slug: p.slug,
		title: p.title,
		summary: p.summary || undefined,
		posterUrl: isPosterUrlSafe(p.poster) ? publicAssetUrl(p.poster!.storageKey) : undefined,
		members: p.members.map((m) => ({ name: m.name, studentId: m.studentId })),
		exhibitionId: p.exhibitionId,
		exhibitionTitle: exhibition.title || `${exhibition.year} 전시`,
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
export async function getProjectDetail(idOrSlug: string, yearParam?: string): Promise<PublicProjectDetailResponse> {
	const yearNum = yearParam ? parseInt(yearParam, 10) : undefined;

	// Try numeric ID lookup first
	const numericId = Number(idOrSlug);
	let project = null;

	if (Number.isInteger(numericId) && numericId > 0) {
		project = await repo.findPublishedProjectById(numericId);
	}

	if (!project) {
		let exhibitionIds: number[] | undefined;
		if (yearNum !== undefined && !isNaN(yearNum)) {
			const exs = await repo.findExhibitionsByYear(yearNum);
			if (exs.length > 0) exhibitionIds = exs.map((e) => e.id);
		}
		project = await repo.findPublishedProjectBySlug(idOrSlug, exhibitionIds);
	}

	if (!project) throw notFound('Project not found');

	const images = project.assets
		.filter((a) => a.kind === 'IMAGE' || a.kind === 'POSTER')
		.map((a) => ({
			id: a.id,
			url: publicAssetUrl(a.storageKey),
			kind: a.kind as 'IMAGE' | 'POSTER',
		}));

	const gameAssets = project.assets.filter((a) => a.kind === 'GAME');
	const gameAsset = gameAssets.length > 0 ? gameAssets[gameAssets.length - 1] : undefined;

	const videos = project.assets
		.filter((a) => a.kind === 'VIDEO' && a.playbackStatus === 'READY')
		.map((videoAsset) => ({
			url: protectedAssetUrl(videoAsset.playbackStorageKey ?? videoAsset.storageKey),
			mimeType: videoAsset.playbackStorageKey
				? videoAsset.playbackMimeType || 'video/mp4'
				: videoAsset.mimeType || 'video/mp4',
		}));
	const video = videos[0] ?? null;

	return {
		id: project.id,
		year: project.exhibition.year,
		slug: project.slug,
		title: project.title,
		summary: project.summary || undefined,
		description: project.description || undefined,
		isIncomplete: effectiveIsIncomplete(project.isIncomplete, project.assets, project.poster),
		video,
		videos,
		members: project.members.map((m) => ({
			id: m.id,
			name: m.name,
			studentId: m.studentId,
		})),
		images,
		posterUrl: isPosterUrlSafe(project.poster) ? publicAssetUrl(project.poster!.storageKey) : undefined,
		gameDownloadUrl: gameAsset
			? protectedAssetUrl(gameAsset.storageKey)
			: undefined,
		status: project.status as 'PUBLISHED' | 'ARCHIVED',
	};
}
