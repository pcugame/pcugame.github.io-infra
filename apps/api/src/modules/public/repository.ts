import { exhibitionVisibilityWhere, projectVisibilityWhere } from '../../shared/visibility-query.js';
import type { VisibilityActor } from '../../shared/visibility.js';
import type { PrismaClient } from '../../generated/prisma/client.js';



const projectDetailInclude = {
	exhibition: true,
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: {
		where: { status: 'READY' as const },
		orderBy: { createdAt: 'asc' as const },
		include: { representations: true, playbackJobs: { orderBy: { createdAt: 'desc' as const }, include: { renditions: true } } },
	},
	poster: { include: { representations: true } },
	currentWebglDeployment: true,
} as const;

/** Bind every public read query to the Prisma client owned by one BackendContext. */
export function createPublicRepository(prisma: PrismaClient) {
	return {
		/** List all exhibitions with published project counts, ordered by sortOrder/year */
		findExhibitionsWithPublishedCounts(actor: VisibilityActor = null) {
			return prisma.exhibition.findMany({
				where: exhibitionVisibilityWhere(actor),
				orderBy: [{ sortOrder: 'asc' }, { year: 'desc' }],
				include: {
					_count: { select: { projects: { where: { ...projectVisibilityWhere(actor) } } } },
					poster: { include: { representations: true } },
				},
			});
		},

		/** Find all Exhibition records matching a given year number */
		findExhibitionsByYear(year: number, actor: VisibilityActor = null) {
			return prisma.exhibition.findMany({ where: { year, ...exhibitionVisibilityWhere(actor) } });
		},

		/** Find published projects within given exhibitionIds, sorted by sortOrder */
		findPublishedProjectsInExhibitions(exhibitionIds: number[], actor: VisibilityActor = null) {
			return prisma.project.findMany({
				where: { ...projectVisibilityWhere(actor), exhibitionId: { in: exhibitionIds } },
				orderBy: { sortOrder: 'asc' },
				include: {
					exhibition: true,
					members: { orderBy: { sortOrder: 'asc' } },
					poster: { include: { representations: true } },
				},
			});
		},

		/** Find a single exhibition by ID */
		findExhibitionById(id: number, actor: VisibilityActor = null) {
			return prisma.exhibition.findFirst({ where: { id, ...exhibitionVisibilityWhere(actor) } });
		},

		/** Find a published project by numeric ID */
		findPublishedProjectById(id: number, actor: VisibilityActor = null) {
			return prisma.project.findFirst({
				where: { id, ...projectVisibilityWhere(actor) },
				include: projectDetailInclude,
			});
		},

		/** Find a published project by slug, optionally scoped to exhibitionIds */
		findPublishedProjectBySlug(slug: string, exhibitionIds?: number[], actor: VisibilityActor = null) {
			return prisma.project.findFirst({
				where: {
					...projectVisibilityWhere(actor),
					slug,
					...(exhibitionIds ? { exhibitionId: { in: exhibitionIds } } : {}),
				},
				include: projectDetailInclude,
			});
		},

	};
}
