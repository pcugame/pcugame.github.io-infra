import type { ExportJobStatus } from './ports.js';

export interface ExportControlRepository {
	createJob(input: {
		id: string;
		requestedById: number;
		year: number | null;
		dryRun: boolean;
	}): Promise<{ id: string }>;
	latestJob(): Promise<ExportJobStatus | null>;
}

/** API-side control plane: no object reader, NAS path, or worker import. */
export function createExportService(deps: {
	repository: ExportControlRepository;
	ids: { next(): string };
}) {
	return {
		createJob(input: { requestedById: number; year?: number; dryRun?: boolean }) {
			return deps.repository.createJob({
				id: deps.ids.next(),
				requestedById: input.requestedById,
				year: input.year ?? null,
				dryRun: input.dryRun ?? false,
			});
		},
		latestJob: () => deps.repository.latestJob(),
	};
}
