import { prisma } from '../../lib/prisma.js';
import { createProjectAccessRepository } from './project-access.repository.js';
import { createProjectAccessService } from './project-access.service.js';

export * from './project-access.service.js';

export const { loadProjectWithAccess } = createProjectAccessService(createProjectAccessRepository(prisma));
