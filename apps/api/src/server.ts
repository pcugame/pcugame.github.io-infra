import { loadEnv } from './config/env.js';

// Load env first
const config = loadEnv();

import { buildApp } from './app.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma, prisma } from './lib/prisma.js';

async function main(): Promise<void> {
	const app = await buildApp();

	try {
		await app.listen({ port: config.PORT, host: '0.0.0.0' });
		logger().info(`Server listening on http://0.0.0.0:${config.PORT}`);
	} catch (err) {
		logger().fatal(err, 'Failed to start server');
		process.exit(1);
	}

	// Purge expired sessions every hour
	const SESSION_PURGE_INTERVAL = 60 * 60 * 1000;
	const purgeTimer = setInterval(async () => {
		try {
			const { count } = await prisma.authSession.deleteMany({
				where: { expiresAt: { lt: new Date() } },
			});
			if (count > 0) logger().info({ count }, 'Purged expired sessions');
		} catch (err) {
			logger().error(err, 'Failed to purge expired sessions');
		}
	}, SESSION_PURGE_INTERVAL);

	const shutdown = async (signal: string) => {
		logger().info(`Received ${signal}, shutting down…`);
		clearInterval(purgeTimer);
		await app.close();
		await disconnectPrisma();
		process.exit(0);
	};

	process.on('SIGTERM', () => void shutdown('SIGTERM'));
	process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
