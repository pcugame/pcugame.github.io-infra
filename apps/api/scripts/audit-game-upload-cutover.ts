import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { auditGameUploadCutover } from '../src/modules/admin/game-upload/cutover-audit.js';
import { createPrismaClientForDatabase } from '../src/lib/prisma-client.js';

export async function main(): Promise<void> {
	dotenv.config({ quiet: true });
	const databaseUrl = process.env['DATABASE_URL'];
	if (!databaseUrl) throw new Error('DATABASE_URL is required');
	const prisma = createPrismaClientForDatabase(databaseUrl);
	try {
		await prisma.$connect();
		const report = await auditGameUploadCutover(prisma, {
			publicBucket: process.env['S3_BUCKET_PUBLIC'] ?? 'pcu-public',
			protectedBucket: process.env['S3_BUCKET_PROTECTED'] ?? 'pcu-protected',
		});
		console.log(JSON.stringify(report, null, 2));
		if (!report.safeToMigrate) process.exitCode = 2;
	} catch {
		console.error('game-upload cutover audit failed; sensitive details were omitted');
		process.exitCode = 1;
	} finally {
		await prisma.$disconnect();
	}
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === pathToFileURL(executedPath).href) {
	void main();
}
