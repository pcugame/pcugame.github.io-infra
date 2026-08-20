import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import { createExportRepository } from '../modules/admin/export/repository.js';

const run = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';

describe.skipIf(!run)('durable export worker repository', () => {
	let first: PrismaClient;
	let second: PrismaClient;

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required');
		first = createPrismaClientForDatabase(databaseUrl);
		second = createPrismaClientForDatabase(databaseUrl);
		await Promise.all([first.$connect(), second.$connect()]);
		await first.exportJob.deleteMany();
	});

	afterAll(async () => {
		if (!first) return;
		await first.exportJob.deleteMany();
		await Promise.all([first.$disconnect(), second.$disconnect()]);
	});

	it('claims with SKIP LOCKED and fences stale tokens using PostgreSQL lease time', async () => {
		const control = createExportRepository(first);
		const competitor = createExportRepository(second);
		const job = await control.createJob({
			id: randomUUID(), requestedById: 1, year: 2026, dryRun: false,
		});
		const firstToken = randomUUID();
		const secondToken = randomUUID();
		const claims = await Promise.all([
			control.claimNext(firstToken, 60_000),
			competitor.claimNext(secondToken, 60_000),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		const owner = claims[0] ? control : competitor;
		const ownerToken = claims[0] ? firstToken : secondToken;
		expect(await owner.heartbeat(job.id, 'wrong-token', 60_000, null)).toBe(false);

		await first.exportJob.update({ where: { id: job.id }, data: { claimUntil: new Date(0) } });
		expect(await owner.complete(job.id, ownerToken, {
			projects: 0, totalFiles: 0, downloaded: 0, skipped: 0, failed: 0,
			aborted: false, paths: [],
		})).toBe(false);

		const recoveryToken = randomUUID();
		await expect(control.claimNext(recoveryToken, 60_000)).resolves.toMatchObject({
			id: job.id, claimToken: recoveryToken,
		});
		expect(await owner.fail(job.id, ownerToken, 'stale worker')).toBe(false);
		expect(await control.complete(job.id, recoveryToken, {
			projects: 0, totalFiles: 0, downloaded: 0, skipped: 0, failed: 0,
			aborted: false, paths: [],
		})).toBe(true);
		await expect(first.exportJob.findUniqueOrThrow({ where: { id: job.id } }))
			.resolves.toMatchObject({ status: 'COMPLETED', claimToken: null, claimUntil: null });
	});
});
