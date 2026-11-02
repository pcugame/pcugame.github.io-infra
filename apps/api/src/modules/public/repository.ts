import { compareAwardProjects } from '../awards/order.js';
import { awardInclude } from '../awards/serialization.js';
import { exhibitionVisibilityWhere, projectVisibilityWhere } from '../../shared/visibility-query.js';
import type { VisibilityActor } from '../../shared/visibility.js';
import type { PrismaClient, ProjectStatus } from '../../generated/prisma/client.js';

const PUBLIC_PROJECT_STATUSES: ProjectStatus[] = ['PUBLISHED', 'ARCHIVED'];

const projectDetailInclude = {
	exhibition: true,
 awards: awardInclude,
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
					_count: { select: { projects: { where: { status: { in: PUBLIC_PROJECT_STATUSES }, ...projectVisibilityWhere(actor) } } } },
					poster: { include: { representations: true } },
				},
			});
		},

		/** Find all Exhibition records matching a given year number */
		findExhibitionsByYear(year: number, actor: VisibilityActor = null) {
			return prisma.exhibition.findMany({ where: { year, ...exhibitionVisibilityWhere(actor) }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
		},

		/** Find published projects within given exhibitionIds, sorted by sortOrder */
		async findPublishedProjectsInExhibitions(exhibitionIds: number[], actor: VisibilityActor = null) {
			const projects = await prisma.project.findMany({
				where: { ...projectVisibilityWhere(actor), exhibitionId: { in: exhibitionIds }, status: { in: PUBLIC_PROJECT_STATUSES } },
				orderBy: { sortOrder: 'asc' },
				include: {
					exhibition: true,
 awards: awardInclude,
					members: { orderBy: { sortOrder: 'asc' } },
					poster: { include: { representations: true } },
				},
			});
			return projects.sort(compareAwardProjects);
		},

		/** Find a single exhibition by ID */
		findExhibitionById(id: number, actor: VisibilityActor = null) {
			return prisma.exhibition.findFirst({ where: { id, ...exhibitionVisibilityWhere(actor) } });
		},

		/** Find a published project by numeric ID */
		findPublishedProjectById(id: number, actor: VisibilityActor = null) {
			return prisma.project.findFirst({
				where: { id, ...projectVisibilityWhere(actor), status: { in: PUBLIC_PROJECT_STATUSES } },
				include: projectDetailInclude,
			});
		},

		/** Find a published project by slug, optionally scoped to exhibitionIds */
		findPublishedProjectBySlug(slug: string, exhibitionIds?: number[], actor: VisibilityActor = null) {
			return prisma.project.findFirst({
				where: {
					...projectVisibilityWhere(actor),
					slug,
					status: { in: PUBLIC_PROJECT_STATUSES },
					...(exhibitionIds ? { exhibitionId: { in: exhibitionIds } } : {}),
				},
				include: projectDetailInclude,
			});
		},

	};
}
