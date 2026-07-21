import { randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import type { Readable } from 'node:stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../../../config/env.js';
import { logger } from '../../../lib/logger.js';
import { prisma } from '../../../lib/prisma.js';
import { bucketForKind, s3 } from '../../../lib/s3.js';
import { createExportRepository } from './repository.js';
import { createExportService } from './service.js';
import { createExportFileWriter } from './file.adapter.js';

let productionService: ReturnType<typeof createExportService> | undefined;

function service() {
	if (productionService) return productionService;
	const repository = createExportRepository(prisma);
	const fileWriter = createExportFileWriter({
		ids: { next: randomUUID },
		async getObject(bucket, key, signal) {
			const response = await s3().send(
				new GetObjectCommand({ Bucket: bucket, Key: key }),
				{ abortSignal: signal },
			);
			return response.Body as Readable;
		},
		createWriteStream,
		rename: fs.rename,
		remove: fs.unlink,
		logCleanupError: (error, path) => logger().warn(
			{ err: error, path },
			'Failed to remove partial export file',
		),
	});
	productionService = createExportService({
		findProjects: repository.findProjectsWithAssets,
		async pathExists(path) {
			try {
				await fs.access(path);
				return true;
			} catch {
				return false;
			}
		},
		ensureDirectory: async (path) => { await fs.mkdir(path, { recursive: true }); },
		saveObject: fileWriter.saveObject,
		bucketForKind,
		protectedBucket: env().S3_BUCKET_PROTECTED,
		now: Date.now,
		logWarn: (message) => logger().warn(message),
		logError: (context, message) => logger().error(context, message),
	});
	return productionService;
}

export const exportService = {
	exportAssets: (...args: Parameters<ReturnType<typeof service>['exportAssets']>) => (
		service().exportAssets(...args)
	),
	getExportProgress: () => service().getExportProgress(),
};

export const exportAssets = exportService.exportAssets;
export const getExportProgress = exportService.getExportProgress;
