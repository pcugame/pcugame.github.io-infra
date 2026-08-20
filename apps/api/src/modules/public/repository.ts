import type { PrismaClient, ProjectStatus } from '../../generated/prisma/client.js';

const PUBLIC_PROJECT_STATUSES: ProjectStatus[] = ['PUBLISHED', 'ARCHIVED'];

const projectDetailInclude = {
	exhibition: true,
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: {
		where: { status: 'READY' as const },
		orderBy: { createdAt: 'asc' as const },
	},
	poster: true,
} as const;

/** Bind every public metadata query to the Prisma client owned by one BackendContext. */
export function createPublicRepository(prisma: PrismaClient) {
	return {
		/** List all exhibitions with published project counts, ordered by sortOrder/year */
		findExhibitionsWithPublishedCounts() {
			return prisma.exhibition.findMany({
				orderBy: [{ sortOrder: 'asc' }, { year: 'desc' }],
				include: {
					_count: { select: { projects: { where: { status: { in: PUBLIC_PROJECT_STATUSES } } } } },
				},
			});
		},

		/** Find all Exhibition records matching a given year number */
		findExhibitionsByYear(year: number) {
			return prisma.exhibition.findMany({ where: { year } });
		},

		/** Find published projects within given exhibitionIds, sorted by sortOrder */
		findPublishedProjectsInExhibitions(exhibitionIds: number[]) {
			return prisma.project.findMany({
				where: { exhibitionId: { in: exhibitionIds }, status: { in: PUBLIC_PROJECT_STATUSES } },
				orderBy: { sortOrder: 'asc' },
				include: {
					members: { orderBy: { sortOrder: 'asc' } },
					poster: true,
				},
			});
		},

		/** Find a single exhibition by ID */
		findExhibitionById(id: number) {
			return prisma.exhibition.findUnique({ where: { id } });
		},

		/** Find a published project by numeric ID */
		findPublishedProjectById(id: number) {
			return prisma.project.findFirst({
				where: { id, status: { in: PUBLIC_PROJECT_STATUSES } },
				include: projectDetailInclude,
			});
		},

		/** Find a published project by slug, optionally scoped to exhibitionIds */
		findPublishedProjectBySlug(slug: string, exhibitionIds?: number[]) {
			return prisma.project.findFirst({
				where: {
					slug,
					status: { in: PUBLIC_PROJECT_STATUSES },
					...(exhibitionIds ? { exhibitionId: { in: exhibitionIds } } : {}),
				},
				include: projectDetailInclude,
			});
		},
	};
}
