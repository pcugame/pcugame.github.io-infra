import type { FastifyPluginAsync } from 'fastify';
import type { ExportProgress, ExportResult } from '@pcu/contracts';
import type { Env } from '../../config/env.js';
import { createExportController } from './export/controller.js';
import type { ExportProject } from './export/ports.js';
import { createImportController } from './import/controller.js';
import { createImportService, type ImportRepository } from './import/service.js';

export interface ExportRepository {
	findProjectsWithAssets(year?: number): Promise<ExportProject[]>;
	createJob(input: {
		id: string;
		requestedById: number;
		year: number | null;
		dryRun: boolean;
	}): Promise<{ id: string }>;
	latestJob(): Promise<{
		id: string;
		status: string;
		progress: ExportProgress | null;
		result: ExportResult | null;
		error: string | null;
	} | null>;
}

type ImportExportConfig = Pick<
	Env,
	'INLINE_UPLOAD_MAX_BYTES' | 'NAS_EXPORT_PATH' | 'S3_BUCKET_PUBLIC' | 'S3_BUCKET_PROTECTED'
>;

export interface ImportExportProductionDependencies {
	config: ImportExportConfig;
	importRepository: ImportRepository;
	exportRepository: ExportRepository;
	ids: { next(): string };
}

export interface ImportExportProductionGraph {
	importController: FastifyPluginAsync;
	exportController: FastifyPluginAsync;
	close(): Promise<void>;
}

/** API-side control graph. It owns no object reader or NAS file writer. */
export function createImportExportProductionGraph(
	deps: ImportExportProductionDependencies,
): ImportExportProductionGraph {
	const importService = createImportService({ repository: deps.importRepository });
	return {
		importController: createImportController({
			service: importService,
			maxEncodedBodySize: deps.config.INLINE_UPLOAD_MAX_BYTES,
		}),
		exportController: createExportController({
			repository: {
				createJob: (input) => deps.exportRepository.createJob(input),
				latestJob: () => deps.exportRepository.latestJob(),
			},
			ids: deps.ids,
		}),
		close: async () => {},
	};
}
