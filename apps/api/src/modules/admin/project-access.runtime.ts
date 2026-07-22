import { prisma } from '../../lib/prisma.js';
import { createProjectAccessRepository } from './project-access.repository.js';
import { createProjectAccessService } from './project-access.service.js';

/**
 * Temporary compatibility graph for ticket-011 multipart and ticket-012 game
 * upload routes. Ticket 008 production controllers never import this module.
 */
export const { loadProjectWithAccess } = createProjectAccessService(
	createProjectAccessRepository(prisma),
);
