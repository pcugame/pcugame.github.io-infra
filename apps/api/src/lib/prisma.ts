import type { PrismaClient } from '../generated/prisma/client.js';
import { logger } from './logger.js';
import { createPrismaClient } from './prisma-client.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  createPrismaClient({
    log:
      process.env['NODE_ENV'] === 'development'
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'stdout', level: 'error' },
          ]
        : [{ emit: 'stdout', level: 'error' }],
  });

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  logger().info('Disconnecting Prisma…');
  await prisma.$disconnect();
}
