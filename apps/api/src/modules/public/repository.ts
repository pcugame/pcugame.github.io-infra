import { prisma } from '../../lib/prisma.js';

/** List all exhibitions with published project counts, ordered by sortOrder/year */
export function findExhibitionsWithPublishedCounts() {
	return prisma.exhibition.findMany({
		orderBy: [{ sortOrder: 'asc' }, { year: 'desc' }],
		include: {
			_count: { select: { projects: { where: { status: 'PUBLISHED' } } } },
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
		where: { exhibitionId: { in: exhibitionIds }, status: 'PUBLISHED' },
		orderBy: { sortOrder: 'asc' },
		include: {
			members: { orderBy: { sortOrder: 'asc' } },
			poster: true,
		},
	});
}

const projectDetailInclude = {
	exhibition: true,
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: { where: { status: 'READY' as const } },
	poster: true,
} as const;

/** Find a published project by numeric ID */
export function findPublishedProjectById(id: number) {
	return prisma.project.findFirst({
		where: { id, status: 'PUBLISHED' },
		include: projectDetailInclude,
	});
}

/** Find a published project by slug, optionally scoped to exhibitionIds */
export function findPublishedProjectBySlug(slug: string, exhibitionIds?: number[]) {
	return prisma.project.findFirst({
		where: {
			slug,
			status: 'PUBLISHED',
			...(exhibitionIds ? { exhibitionId: { in: exhibitionIds } } : {}),
		},
		include: projectDetailInclude,
	});
}
