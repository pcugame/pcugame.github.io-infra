import { prisma } from '../../../lib/prisma.js';

export interface ExportProject {
	id: number;
	title: string;
	exhibition: { year: number; title: string };
	members: { name: string; studentId: string; sortOrder: number }[];
	assets: {
		id: number;
		kind: string;
		storageKey: string;
		originalName: string;
		mimeType: string;
		sizeBytes: bigint;
	}[];
}

/** Fetch all projects that have READY assets, optionally filtered by year. */
export async function findProjectsWithAssets(
	yearFilter?: number,
): Promise<ExportProject[]> {
	return prisma.project.findMany({
		where: {
			assets: { some: { status: 'READY' } },
			...(yearFilter ? { exhibition: { year: yearFilter } } : {}),
		},
		include: {
			exhibition: { select: { year: true, title: true } },
			members: { orderBy: { sortOrder: 'asc' }, select: { name: true, studentId: true, sortOrder: true } },
			assets: {
				where: { status: 'READY' },
				orderBy: [{ kind: 'asc' }, { id: 'asc' }],
				select: { id: true, kind: true, storageKey: true, originalName: true, mimeType: true, sizeBytes: true },
			},
		},
		orderBy: [
			{ exhibition: { year: 'asc' } },
			{ sortOrder: 'asc' },
			{ id: 'asc' },
		],
	});
}
