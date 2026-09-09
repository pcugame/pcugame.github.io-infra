import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../../lib/prisma-client.js';

/** Production repositories use real migrations but cannot see shared CI workers or fixtures. */
export async function createIsolatedMigratedDatabase(baseUrl: string) {
	const schema = `integration_${randomUUID().replaceAll('-', '')}`;
	const bootstrap = createPrismaClientForDatabase(baseUrl);
	const clients: PrismaClient[] = [];
	async function close(): Promise<void> {
		try {
			await Promise.all(clients.map((client) => client.$disconnect()));
		} finally {
			try { await bootstrap.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
			finally { await bootstrap.$disconnect(); }
		}
	}
	try {
		await bootstrap.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
		const migrations = new URL('../../../prisma/migrations/', import.meta.url);
		const directories = (await readdir(migrations, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
		for (const directory of directories) {
			const connection = createPrismaClientForDatabase(baseUrl);
			try {
				const sql = await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8');
				await connection.$executeRawUnsafe(`SET search_path TO "${schema}";\n${sql}`);
			} finally { await connection.$disconnect(); }
		}
	} catch (error) {
		await close();
		throw error;
	}
	const isolatedUrl = new URL(baseUrl);
	isolatedUrl.searchParams.set('schema', schema);
	isolatedUrl.searchParams.set('options', `-c search_path=${schema}`);
	return {
		createClient() {
			const client = createPrismaClientForDatabase(isolatedUrl.toString());
			clients.push(client);
			return client;
		},
		close,
	};
}
