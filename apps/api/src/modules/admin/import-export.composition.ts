import type { AssetKind } from '@pcu/contracts';
import type { FastifyPluginAsync } from 'fastify';
import type {
	AppLogger,
	Clock,
	FileSystem,
	IdGenerator,
	ObjectStorage,
} from '../../application/ports.js';
import type { Env } from '../../config/env.js';
import { createExportController } from './export/controller.js';
import { createExportFileWriter } from './export/file.adapter.js';
import {
	createExportService,
	type ExportProject,
	type ExportProgressStore,
} from './export/service.js';
import { createImportController } from './import/controller.js';
import { createImportService, type ImportRepository } from './import/service.js';

export interface ExportRepository {
	findProjectsWithAssets(year?: number): Promise<ExportProject[]>;
}

type ImportExportConfig = Pick<
	Env,
	'NAS_EXPORT_PATH' | 'S3_BUCKET_PUBLIC' | 'S3_BUCKET_PROTECTED'
>;

export interface ImportExportProductionDependencies {
	config: ImportExportConfig;
	importRepository: ImportRepository;
	exportRepository: ExportRepository;
	storage: ObjectStorage;
	fileSystem: FileSystem;
	exportProgress: ExportProgressStore;
	clock: Clock;
	ids: IdGenerator;
	logger: AppLogger;
}

export interface ImportExportProductionGraph {
	importController: FastifyPluginAsync;
	exportController: FastifyPluginAsync;
	close(): Promise<void>;
}

function bucketForKind(kind: AssetKind, config: ImportExportConfig): string {
	return kind === 'GAME' || kind === 'VIDEO'
		? config.S3_BUCKET_PROTECTED
		: config.S3_BUCKET_PUBLIC;
}

/**
 * Compose ticket-010 entirely from resources owned by one BackendContext.
 * Construction and route registration perform no external I/O.
 */
export function createImportExportProductionGraph(
	deps: ImportExportProductionDependencies,
): ImportExportProductionGraph {
	const importService = createImportService({ repository: deps.importRepository });
	const fileWriter = createExportFileWriter({
		ids: deps.ids,
		async getObject(bucket, key, signal) {
			const object = await deps.storage.stream(bucket, key, undefined, { signal });
			if (!object) throw new Error(`Export object not found: ${key}`);
			return object.body;
		},
		createWriteStream: (path) => deps.fileSystem.createWriteStream(path),
		rename: (from, to) => deps.fileSystem.rename(from, to),
		remove: (path) => deps.fileSystem.remove(path),
		logCleanupError: (error, path) => deps.logger.warn(
			{ err: error, path },
			'Failed to remove partial export file',
		),
	});
	const exportService = createExportService({
		findProjects: deps.exportRepository.findProjectsWithAssets,
		async pathExists(path) {
			try {
				await deps.fileSystem.access(path);
				return true;
			} catch {
				return false;
			}
		},
		ensureDirectory: (path) => deps.fileSystem.mkdir(path, { recursive: true }),
		saveObject: fileWriter.saveObject,
		bucketForKind: (kind) => bucketForKind(kind, deps.config),
		protectedBucket: deps.config.S3_BUCKET_PROTECTED,
		now: () => deps.clock.now().getTime(),
		logWarn: (message) => deps.logger.warn(message),
		logError: (context, message) => deps.logger.error(context, message),
	}, deps.exportProgress);

	return {
		importController: createImportController({ service: importService }),
		exportController: createExportController({
			service: exportService,
			outDir: deps.config.NAS_EXPORT_PATH,
		}),
		close: () => exportService.close(),
	};
}
