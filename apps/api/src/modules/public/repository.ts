import type { Prisma, PrismaClient, ProjectStatus } from '../../generated/prisma/client.js';
import {
	IMAGE_RENDITION_PROFILES,
	parseImageRenditionStorageKey,
} from '../../shared/responsive-image.js';

const PUBLIC_PROJECT_STATUSES: ProjectStatus[] = ['PUBLISHED', 'ARCHIVED'];

const projectDetailInclude = {
	exhibition: true,
	members: { orderBy: { sortOrder: 'asc' as const } },
	assets: {
		where: { status: 'READY' as const },
		orderBy: { createdAt: 'asc' as const },
		include: { representations: true },
	},
	poster: { include: { representations: true } },
	currentWebglDeployment: true,
} as const;

/** Bind every public read query to the Prisma client owned by one BackendContext. */
export function createPublicRepository(prisma: PrismaClient) {
	async function findExactPublicImageOwner(storageKey: string) {
		const asset = await prisma.asset.findFirst({
			where: {
				storageKey,
				status: 'READY',
				isPublic: true,
				kind: { in: ['IMAGE', 'POSTER', 'THUMBNAIL'] },
				project: { status: { in: PUBLIC_PROJECT_STATUSES } },
			},
			select: {
				id: true,
				storageKey: true,
				width: true,
				card480Height: true,
				display960Height: true,
				representations: true,
			},
		});
		if (asset) return { owner: 'asset' as const, image: asset };

		const exhibition = await prisma.exhibition.findUnique({
			where: { posterStorageKey: storageKey },
			select: {
				posterAssetId: true,
				posterStorageKey: true,
				posterWidth: true,
				posterCard480Height: true,
				posterDisplay960Height: true,
				poster: { select: { representations: true } },
			},
		});
		if (exhibition?.posterStorageKey !== storageKey) return null;
		return { owner: 'exhibition' as const, image: exhibition };
	}

	return {
		async recordMigrationMetric(name: string, scope: string, details?: Record<string, unknown>) {
			await prisma.migrationMetric.upsert({
				where: { name_scope: { name, scope } },
				create: {
					name,
					scope,
					value: 1n,
					lastObservedAt: new Date(),
					...(details ? { details: details as Prisma.InputJsonValue } : {}),
				},
				update: {
					value: { increment: 1n },
					lastObservedAt: new Date(),
					...(details ? { details: details as Prisma.InputJsonValue } : {}),
				},
			});
		},
		/** List all exhibitions with published project counts, ordered by sortOrder/year */
		findExhibitionsWithPublishedCounts() {
			return prisma.exhibition.findMany({
				orderBy: [{ sortOrder: 'asc' }, { year: 'desc' }],
				include: {
					_count: { select: { projects: { where: { status: { in: PUBLIC_PROJECT_STATUSES } } } } },
					poster: { include: { representations: true } },
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
					poster: { include: { representations: true } },
				},
			});
		},

		/** Find a single exhibition by ID */
		findExhibitionById(id: number) {
			return prisma.exhibition.findUnique({ where: { id } });
		},

		/** Resolve one current, publicly visible canonical image or rendition. */
		async resolvePublicImage(storageKey: string) {
			const parsed = parseImageRenditionStorageKey(storageKey);
			if (parsed) {
				const sourceOwner = await findExactPublicImageOwner(parsed.sourceStorageKey);
				const definition = IMAGE_RENDITION_PROFILES.find(
					(candidate) => candidate.profile === parsed.profile,
				);
				if (sourceOwner && definition) {
					const sourceWidth = sourceOwner.owner === 'asset'
						? sourceOwner.image.width
						: sourceOwner.image.posterWidth;
					const renditionHeight = sourceOwner.owner === 'asset'
						? sourceOwner.image[definition.heightField]
						: sourceOwner.image[definition.posterHeightField];
					if (sourceWidth != null && sourceWidth > definition.width && renditionHeight != null) {
						return { storageKey };
					}
				}
				const legacyOriginal = await findExactPublicImageOwner(storageKey);
				return legacyOriginal ? { storageKey } : null;
			}
			const original = await findExactPublicImageOwner(storageKey);
			return original ? { storageKey } : null;
		},

		/** Resolve a Phase 1 image bridge without reading object bytes. */
		async resolvePublicImageBridge(storageKey: string) {
			const canonical = await prisma.assetRepresentation.findFirst({
				where: {
					objectKey: storageKey,
					state: 'READY',
					role: { in: ['ORIGINAL', 'CARD_480', 'DISPLAY_960'] },
					asset: {
						status: 'READY',
						isPublic: true,
						kind: { in: ['IMAGE', 'POSTER', 'THUMBNAIL'] },
						OR: [
							{ project: { is: { status: { in: PUBLIC_PROJECT_STATUSES } } } },
							{ posterOfExhibition: { isNot: null } },
						],
					},
				},
				select: { bucket: true, objectKey: true },
			});
			if (canonical) return { ...canonical, usedLegacy: false };

			const parsed = parseImageRenditionStorageKey(storageKey);
			if (parsed) {
				const sourceOwner = await findExactPublicImageOwner(parsed.sourceStorageKey);
				const definition = IMAGE_RENDITION_PROFILES.find(
					(candidate) => candidate.profile === parsed.profile,
				);
				if (sourceOwner && definition) {
					const representations = sourceOwner.owner === 'asset'
						? sourceOwner.image.representations
						: sourceOwner.image.poster?.representations ?? [];
					if (representations.length > 0) {
						const representation = representations.find((candidate) => (
							candidate.role === parsed.profile && candidate.state === 'READY'
						));
						return representation
							? { bucket: representation.bucket, objectKey: representation.objectKey, usedLegacy: true }
							: null;
					}
					const sourceWidth = sourceOwner.owner === 'asset'
						? sourceOwner.image.width
						: sourceOwner.image.posterWidth;
					const renditionHeight = sourceOwner.owner === 'asset'
						? sourceOwner.image[definition.heightField]
						: sourceOwner.image[definition.posterHeightField];
					if (sourceWidth != null && sourceWidth > definition.width && renditionHeight != null) {
						return { bucket: '', objectKey: storageKey, usedLegacy: true };
					}
				}
				// The suffix is reserved only for newly generated keys. Preserve an
				// exact legacy original that happened to use the same shape.
				const legacyOriginal = await findExactPublicImageOwner(storageKey);
				return legacyOriginal ? { bucket: '', objectKey: storageKey, usedLegacy: true } : null;
			}

			const original = await findExactPublicImageOwner(storageKey);
			if (!original) return null;
			const representations = original.owner === 'asset'
				? original.image.representations
				: original.image.poster?.representations ?? [];
			if (representations.length > 0) {
				const representation = representations.find((candidate) => (
					candidate.role === 'ORIGINAL' && candidate.state === 'READY'
				));
				return representation
					? { bucket: representation.bucket, objectKey: representation.objectKey, usedLegacy: true }
					: null;
			}
			return { bucket: '', objectKey: storageKey, usedLegacy: true };
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
				where: {
					id,
					status: { in: PUBLIC_PROJECT_STATUSES },
					OR: [
						{ currentWebglDeploymentId: { not: null } },
						{ webglEntryKey: { not: '' } },
					],
				},
				select: {
					id: true,
					webglEntryKey: true,
					currentWebglDeploymentId: true,
					currentWebglDeployment: true,
				},
			});
		},
	};
}
