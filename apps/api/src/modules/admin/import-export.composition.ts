import type { FastifyPluginAsync } from 'fastify';
import type { IdGenerator } from '../../application/ports.js';
import { createExportController } from './export/controller.js';
import {
	createExportService,
	type ExportControlRepository,
} from './export/service.js';
import { createImportController } from './import/controller.js';
import { createImportService, type ImportRepository } from './import/service.js';

/**
 * API-side export persistence intentionally ends at ExportJob creation/status.
 * Garage reads and NAS writes belong exclusively to export-worker.
 */
export type ExportRepository = ExportControlRepository;

export interface ImportExportProductionDependencies {
	importRepository: ImportRepository;
	exportRepository: ExportRepository;
	ids: IdGenerator;
}

export interface ImportExportProductionGraph {
	importController: FastifyPluginAsync;
	exportController: FastifyPluginAsync;
	close(): Promise<void>;
}

/**
 * Compose the admin import control plane and the export-job control plane.
 * Construction and route registration perform no external I/O. In particular,
 * this graph has no Garage reader, NAS filesystem, or export worker dependency.
 */
export function createImportExportProductionGraph(
	deps: ImportExportProductionDependencies,
): ImportExportProductionGraph {
	const importService = createImportService({ repository: deps.importRepository });
	const exportService = createExportService({
		repository: deps.exportRepository,
		ids: deps.ids,
	});

	return {
		importController: createImportController({ service: importService }),
		exportController: createExportController({ service: exportService }),
		close: async () => undefined,
	};
}
