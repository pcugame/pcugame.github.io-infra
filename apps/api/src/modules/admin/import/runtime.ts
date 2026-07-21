import { prisma } from '../../../lib/prisma.js';
import { createImportRepository } from './repository.js';
import { createImportService } from './service.js';

export const importService = createImportService({
	repository: createImportRepository(prisma),
});
