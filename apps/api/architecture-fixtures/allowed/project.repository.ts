import type { PrismaClient } from '../src/generated/prisma/client.js';

export function createProjectRepository(client: PrismaClient) {
	return { client };
}
