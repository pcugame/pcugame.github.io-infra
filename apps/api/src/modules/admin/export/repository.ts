import type { PrismaClient } from '../../../generated/prisma/client.js';
import type { ExportProject } from './service.js';

export function createExportRepository(client: PrismaClient) {
	return {
		/** Fetch all projects that have READY assets, optionally filtered by year. */
		async findProjectsWithAssets(yearFilter?: number): Promise<ExportProject[]> {
			return client.project.findMany({
				where: {
					OR: [
						{ assets: { some: { status: 'READY' } } },
						{ webglEntryKey: { not: '' } },
					],
					...(yearFilter ? { exhibition: { year: yearFilter } } : {}),
				},
				include: {
					exhibition: { select: { year: true, title: true } },
					members: {
						orderBy: { sortOrder: 'asc' },
						select: { name: true, studentId: true, sortOrder: true },
					},
					assets: {
						where: { status: 'READY' },
						orderBy: [{ kind: 'asc' }, { id: 'asc' }],
						select: {
							id: true,
							kind: true,
							storageKey: true,
							originalName: true,
							mimeType: true,
							sizeBytes: true,
						},
					},
				},
				orderBy: [
					{ exhibition: { year: 'asc' } },
					{ sortOrder: 'asc' },
					{ id: 'asc' },
				],
			});
		},
	};
}
