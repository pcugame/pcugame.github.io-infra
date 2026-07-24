import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { createCachedSettingsStore, createSiteSettingsRepository } from './site-settings.js';

/**
 * Existing process-global compatibility store for the ticket-012 game-upload
 * runtime. Ticket-008 controllers and BackendContext never import this module.
 */
export const legacySiteSettingsStore = createCachedSettingsStore(
	createSiteSettingsRepository(prisma),
	{ logger: { warn: (value, message) => logger().warn(value, message) } },
);

export const getSiteSettings = legacySiteSettingsStore.get;
