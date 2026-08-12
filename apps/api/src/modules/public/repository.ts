import type { PrismaClient, ProjectStatus } from '../../generated/prisma/client.js';

const PUBLIC_PROJECT_STATUSES: ProjectStatus[] = ['PUBLISHED', 'ARCHIVED'];

const projectDetailInclude = {
	exhibition: true,
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: {
		where: { status: 'READY' as const },
		orderBy: { createdAt: 'asc' as const },
		include: { imageRenditions: true },
	},
	poster: { include: { imageRenditions: true } },
} as const;

/** Bind every public read query to the Prisma client owned by one BackendContext. */
export function createPublicRepository(prisma: PrismaClient) {
	return {
		/** List all exhibitions with published project counts, ordered by sortOrder/year */
		findExhibitionsWithPublishedCounts() {
			return prisma.exhibition.findMany({
				orderBy: [{ sortOrder: 'asc' }, { year: 'desc' }],
				include: {
					_count: { select: { projects: { where: { status: { in: PUBLIC_PROJECT_STATUSES } } } } },
					imageRenditions: true,
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
					poster: { include: { imageRenditions: true } },
				},
			});
		},

		/** Find a single exhibition by ID */
		findExhibitionById(id: number) {
			return prisma.exhibition.findUnique({ where: { id } });
		},

		/** Resolve one current, publicly visible canonical image or rendition. */
		async resolvePublicImage(storageKey: string) {
			const asset = await prisma.asset.findFirst({
				where: {
					storageKey,
					status: 'READY',
					isPublic: true,
					kind: { in: ['IMAGE', 'POSTER', 'THUMBNAIL'] },
					project: { status: { in: PUBLIC_PROJECT_STATUSES } },
				},
				select: { storageKey: true },
			});
			if (asset) return asset;

			const exhibition = await prisma.exhibition.findUnique({
				where: { posterStorageKey: storageKey },
				select: { posterStorageKey: true },
			});
			if (exhibition?.posterStorageKey === storageKey) return { storageKey };

			const rendition = await prisma.imageRendition.findUnique({
				where: { storageKey },
				select: {
					storageKey: true,
					sourceStorageKey: true,
					asset: {
						select: {
							storageKey: true,
							status: true,
							isPublic: true,
							kind: true,
							project: { select: { status: true } },
						},
					},
					exhibition: { select: { posterStorageKey: true } },
				},
			});
			if (!rendition) return null;

			const ownerAsset = rendition.asset;
			if (
				ownerAsset
				&& ownerAsset.storageKey === rendition.sourceStorageKey
				&& ownerAsset.status === 'READY'
				&& ownerAsset.isPublic
				&& (ownerAsset.kind === 'IMAGE'
					|| ownerAsset.kind === 'POSTER'
					|| ownerAsset.kind === 'THUMBNAIL')
				&& PUBLIC_PROJECT_STATUSES.includes(ownerAsset.project.status)
			) {
				return { storageKey: rendition.storageKey };
			}
			if (rendition.exhibition?.posterStorageKey === rendition.sourceStorageKey) {
				return { storageKey: rendition.storageKey };
			}
			return null;
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

		/** Resolve the currently active WebGL pointer for a publicly visible project. */
		findPublicWebglProject(id: number) {
			return prisma.project.findFirst({
				where: { id, status: { in: PUBLIC_PROJECT_STATUSES }, webglEntryKey: { not: '' } },
				select: { id: true, webglEntryKey: true },
			});
		},
	};
}
