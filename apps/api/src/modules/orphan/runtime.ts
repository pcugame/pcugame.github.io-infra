import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { deleteObject } from '../../lib/storage.js';
import { createOrphanRepository } from './repository.js';
import { createOrphanService } from './service.js';

export const orphanService = createOrphanService({
	clock: { now: () => new Date() },
	storage: { delete: deleteObject },
	repository: createOrphanRepository(prisma),
	logger: {
		info: (context, message) => logger().info(context, message),
		error: (context, message) => logger().error(context, message),
	},
});
