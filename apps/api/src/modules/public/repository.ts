import { prisma } from '../../lib/prisma.js';
import type { ProjectStatus } from '../../generated/prisma/client.js';

const PUBLIC_PROJECT_STATUSES: ProjectStatus[] = ['PUBLISHED', 'ARCHIVED'];

/** List all exhibitions with published project counts, ordered by sortOrder/year */
export function findExhibitionsWithPublishedCounts() {
	return prisma.exhibition.findMany({
		orderBy: [{ sortOrder: 'asc' }, { year: 'desc' }],
		include: {
			_count: { select: { projects: { where: { status: { in: PUBLIC_PROJECT_STATUSES } } } } },
		},
	});
}

/** Find all Exhibition records matching a given year number */
export function findExhibitionsByYear(year: number) {
	return prisma.exhibition.findMany({ where: { year } });
}

/** Find published projects within given exhibitionIds, sorted by sortOrder */
export function findPublishedProjectsInExhibitions(exhibitionIds: number[]) {
	return prisma.project.findMany({
		where: { exhibitionId: { in: exhibitionIds }, status: { in: PUBLIC_PROJECT_STATUSES } },
		orderBy: { sortOrder: 'asc' },
		include: {
			members: { orderBy: { sortOrder: 'asc' } },
			poster: true,
		},
	});
}

/** Find a single exhibition by ID */
export function findExhibitionById(id: number) {
	return prisma.exhibition.findUnique({ where: { id } });
}

/** Find an exhibition poster by storage key. */
export function findExhibitionPosterByStorageKey(storageKey: string) {
	return prisma.exhibition.findUnique({
		where: { posterStorageKey: storageKey },
		select: { id: true, posterStorageKey: true },
	});
}

const projectDetailInclude = {
	exhibition: true,
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: { where: { status: 'READY' as const }, orderBy: { createdAt: 'asc' as const } },
	poster: true,
} as const;

/** Find a published project by numeric ID */
export function findPublishedProjectById(id: number) {
	return prisma.project.findFirst({
		where: { id, status: { in: PUBLIC_PROJECT_STATUSES } },
		include: projectDetailInclude,
	});
}

/** Find a published project by slug, optionally scoped to exhibitionIds */
export function findPublishedProjectBySlug(slug: string, exhibitionIds?: number[]) {
	return prisma.project.findFirst({
		where: {
			slug,
			status: { in: PUBLIC_PROJECT_STATUSES },
			...(exhibitionIds ? { exhibitionId: { in: exhibitionIds } } : {}),
		},
		include: projectDetailInclude,
	});
}

/** Resolve the currently active WebGL pointer for a publicly visible project. */
export function findPublicWebglProject(id: number) {
	return prisma.project.findFirst({
		where: { id, status: { in: PUBLIC_PROJECT_STATUSES }, webglEntryKey: { not: '' } },
		select: { id: true, webglEntryKey: true },
	});
}
