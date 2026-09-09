import type { Env } from '../src/config/env.js';
import { createPrismaClientForDatabase } from '../src/lib/prisma-client.js';
import { createS3Client } from '../src/lib/s3.js';
import { createObjectStorage } from '../src/lib/storage.js';
import { createRootLogger } from '../src/lib/logger.js';

/** Resources owned by a one-shot read/control-plane administrative invocation. */
export function createScriptResources(config: Env) {
	const prisma = createPrismaClientForDatabase(config.DATABASE_URL);
	const s3 = createS3Client(config);
	const storage = createObjectStorage(s3, {
		defaultPresignTtlSec: config.S3_PRESIGN_TTL_SEC,
	});
	const logger = createRootLogger(config);
	let closePromise: Promise<void> | undefined;

	return {
		prisma,
		storage,
		logger,
		close() {
			closePromise ??= (async () => {
				s3.destroy();
				await prisma.$disconnect();
			})();
			return closePromise;
		},
	};
}
