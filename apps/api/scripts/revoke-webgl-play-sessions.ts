import { pathToFileURL } from 'node:url';
import { createPrismaClientForDatabase } from '../src/lib/prisma-client.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';

export function revokeOptions(args: string[]): { external: boolean; apply: boolean } {
	if (args.some(arg => !['--all', '--external', '--apply'].includes(arg))
		|| new Set(args).size !== args.length
		|| Number(args.includes('--all')) + Number(args.includes('--external')) !== 1) {
		throw new Error('Usage: revoke-webgl-play-sessions (--all | --external) [--apply]; default is dry-run');
	}
	return { external: args.includes('--external'), apply: args.includes('--apply') };
}

export async function revokePlaySessions(
	client: Pick<PrismaClient, 'webglPlaySession'>,
	options: ReturnType<typeof revokeOptions>,
	at = new Date(),
): Promise<{ mode: string; scope: string; count: number }> {
	const where = { revokedAt: null, ...(options.external ? { approvedOrigins: { isEmpty: false } } : {}) };
	const count = options.apply
		? (await client.webglPlaySession.updateMany({ where, data: { revokedAt: at } })).count
		: await client.webglPlaySession.count({ where });
	return { mode: options.apply ? 'applied' : 'dry-run', scope: options.external ? 'external' : 'all', count };
}

async function main() {
	const options = revokeOptions(process.argv.slice(2));
	const databaseUrl = process.env['DATABASE_URL'];
	if (!databaseUrl) throw new Error('DATABASE_URL is required');
	const client = createPrismaClientForDatabase(databaseUrl);
	try { console.log(JSON.stringify(await revokePlaySessions(client, options))); }
	finally { await client.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void main().catch(() => { console.error('Play-session revocation failed; verify arguments, migration and database availability.'); process.exitCode = 1; });
}
