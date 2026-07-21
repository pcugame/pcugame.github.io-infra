import { createObjectDeletionCoordinator } from './application/object-deletion.js';
import { logger } from './lib/logger.js';
import * as storage from './lib/storage.js';
import { orphanService } from './modules/orphan/runtime.js';

const coordinator = createObjectDeletionCoordinator({
	storage: {
		delete: (bucket, key) => storage.deleteObject(bucket, key),
		listKeys: (bucket, prefix) => storage.listObjectKeys(bucket, prefix),
	},
	orphans: { record: orphanService.recordOrphan },
	logger: {
		error: (context, message) => logger().error(context, message),
	},
});

export const safeDeleteObject = coordinator.deleteOrQueue;
export const safeDeletePrefix = coordinator.deletePrefixOrQueue;
