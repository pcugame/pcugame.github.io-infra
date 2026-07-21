import type { PrismaClient } from '../../../generated/prisma/client.js';
import type {
	ImportProjectCreate,
	ImportRepository,
	ImportTransactionRepository,
} from './service.js';

type TransactionClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

function createTransactionRepository(tx: TransactionClient): ImportTransactionRepository {
	return {
		findExhibitionByComposite: (year, title) => tx.exhibition.findUnique({
			where: { year_title: { year, title } },
			include: { _count: { select: { projects: true } } },
		}),

		upsertExhibition: (data) => tx.exhibition.upsert({
			where: { year_title: { year: data.year, title: data.title } },
			update: {},
			create: {
				year: data.year,
				title: data.title,
				isUploadEnabled: data.isUploadEnabled ?? true,
			},
		}),

		findProjectBySlug: (exhibitionId, slug) => tx.project.findUnique({
			where: { project_exhibition_slug: { exhibitionId, slug } },
			select: { id: true },
		}),

		createProjectWithMembers: (data: ImportProjectCreate) => {
			const { members, ...projectData } = data;
			return tx.project.create({
				data: {
					...projectData,
					members: { create: members },
				},
			});
		},
	};
}

/** Prisma adapter. Interactive transaction details stay behind this port. */
export function createImportRepository(client: PrismaClient): ImportRepository {
	return {
		findExhibitionForPreview: (year, title) => client.exhibition.findUnique({
			where: { year_title: { year, title } },
			include: { _count: { select: { projects: true } } },
		}),

		runTransaction: (work) => client.$transaction(
			(tx) => work(createTransactionRepository(tx)),
			{ timeout: 30_000 },
		),
	};
}
