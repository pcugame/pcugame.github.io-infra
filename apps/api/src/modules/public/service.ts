import { env } from '../../config/env.js';
import { notFound } from '../../shared/errors.js';
import { sanitizeStudentId } from '../../shared/student-id.js';
import { isPosterUrlSafe } from '../../shared/poster-validation.js';
import * as repo from './repository.js';

/** Build a public asset URL */
function publicAssetUrl(storageKey: string): string {
	return `${env().API_PUBLIC_URL}/api/assets/public/${storageKey}`;
}

/** List all years with published project counts */
export async function listYears() {
	const exhibitions = await repo.findExhibitionsWithPublishedCounts();
	return exhibitions.map((e) => ({
		id: e.id,
		year: e.year,
		title: e.title || undefined,
		projectCount: e._count.projects,
	}));
}

/** List published projects for a given year number (supports multiple exhibitions) */
export async function listProjectsByYear(yearParam: string) {
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
			members: p.members.map((m) => ({ name: m.name, studentId: sanitizeStudentId(m.studentId) })),
			exhibitionId: p.exhibitionId,
			exhibitionTitle: ex?.title || `${yearNum} 전시`,
		};
	});

	return { year: yearNum, exhibitions, items, empty: items.length === 0 };
}

/** Get a single published project by ID or slug */
export async function getProjectDetail(idOrSlug: string, yearParam?: string) {
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

	return {
		id: project.id,
		year: project.exhibition.year,
		slug: project.slug,
		title: project.title,
		summary: project.summary || undefined,
		description: project.description || undefined,
		isLegacy: project.isLegacy,
		video: project.videoUrl
			? {
					provider: 'NAS' as const,
					url: project.videoUrl,
					mimeType: project.videoMimeType || 'video/mp4',
				}
			: null,
		members: project.members.map((m) => ({
			id: m.id,
			name: m.name,
			studentId: sanitizeStudentId(m.studentId),
		})),
		images,
		posterUrl: isPosterUrlSafe(project.poster) ? publicAssetUrl(project.poster!.storageKey) : undefined,
		gameDownloadUrl: gameAsset
			? `${env().API_PUBLIC_URL}/api/assets/protected/${gameAsset.storageKey}`
			: undefined,
		status: 'PUBLISHED' as const,
	};
}
