import { loadEnv } from './config/env.js';

// Load env first
const config = loadEnv();

import { buildApp } from './app.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';

async function main(): Promise<void> {
  const app = await buildApp();

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info(`Server listening on http://0.0.0.0:${config.PORT}`);
  } catch (err) {
    logger.fatal(err, 'Failed to start server');
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down…`);
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
