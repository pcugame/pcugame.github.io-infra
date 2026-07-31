import { prisma as defaultClient } from './src/lib/prisma.js';

export function createProjectRepository(client = defaultClient) {
	return { client };
}
