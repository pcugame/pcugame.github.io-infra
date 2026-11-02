import type { ProjectStatus } from '@pcu/contracts';

/** Bulk update project status */
export async function bulkUpdateStatus(
	repository: { bulkUpdateStatus(ids: number[], status: ProjectStatus): Promise<{ count: number }> },
	ids: number[],
	status: ProjectStatus,
) {
	const result = await repository.bulkUpdateStatus(ids, status);
	return { updated: result.count };
}
