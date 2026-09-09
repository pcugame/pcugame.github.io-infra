import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createPrismaClientForDatabase } from '../../lib/prisma-client.js';

/** Isolate fixtures that intentionally configure their own object buckets. */
export async function createPhase1TestDatabase(sourceUrl: string) {
	const schema = `phase1_fixture_${randomUUID().replaceAll('-', '')}`;
	const control = createPrismaClientForDatabase(sourceUrl);
	const close = async () => {
		try { await control.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
		finally { await control.$disconnect(); }
	};
	try {
		await control.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
		const root = new URL('../../../prisma/migrations/', import.meta.url);
		const names = (await readdir(root, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory() && entry.name < '20260822000000_canonical_asset_contract')
			.map(({ name }) => name).sort();
		for (const name of names) {
			await control.$executeRawUnsafe(`SET search_path TO "${schema}";\n${await readFile(new URL(`${name}/migration.sql`, root), 'utf8')}`);
		}
	} catch (error) {
		await control.$executeRawUnsafe('ROLLBACK');
		await close();
		throw error;
	}
	const url = new URL(sourceUrl);
	url.searchParams.set('schema', schema);
	url.searchParams.set('options', `-c search_path=${schema}`);
	return { databaseUrl: url.toString(), close };
}
