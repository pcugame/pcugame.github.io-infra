import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createPrismaClientForDatabase } from '../lib/prisma-client.js';
import {
	createIdempotencyRepository,
	succeedIdempotencyOperation,
} from '../modules/idempotency/repository.js';
import { createIdempotencyService } from '../modules/idempotency/service.js';

const runPostgresIntegration = process.env['RUN_POSTGRES_INTEGRATION'] === 'true';

describe.runIf(runPostgresIntegration)('idempotency operations with PostgreSQL', () => {
	const testId = randomUUID();
	let prisma: PrismaClient;
	let userId: number;
	let exhibitionId: number;
	let assetProjectId: number;
	const now = new Date('2026-08-11T00:00:00.000Z');

	function service() {
		return createIdempotencyService({
			repository: createIdempotencyRepository(prisma),
			clock: { now: () => now },
			ids: { next: () => randomUUID() },
		});
	}

	beforeAll(async () => {
		const databaseUrl = process.env['DATABASE_URL'];
		if (!databaseUrl) throw new Error('DATABASE_URL is required');
		prisma = createPrismaClientForDatabase(databaseUrl);
		await prisma.$connect();
		const user = await prisma.user.create({
			data: {
				googleSub: `idempotency-${testId}`,
				email: `idempotency-${testId}@example.test`,
				name: 'Idempotency integration',
				role: 'ADMIN',
			},
		});
		userId = user.id;
		const exhibition = await prisma.exhibition.create({
			data: { year: 2096, title: `Idempotency ${testId}` },
		});
		exhibitionId = exhibition.id;
		const project = await prisma.project.create({
			data: {
				exhibitionId,
				creatorId: userId,
				slug: `idempotency-assets-${testId}`,
				title: 'Idempotency asset fixture',
			},
		});
		assetProjectId = project.id;
	});

	afterAll(async () => {
		if (!prisma) return;
		await prisma.idempotencyOperation.deleteMany({ where: { actorId: userId } });
		await prisma.project.deleteMany({ where: { exhibitionId } });
		await prisma.exhibition.deleteMany({ where: { id: exhibitionId } });
		await prisma.user.deleteMany({ where: { id: userId } });
		await prisma.$disconnect();
	});

	it('replays one committed project and rejects a different payload for the same key', async () => {
		const idempotency = service();
		const key = `project-${testId}`;
		const requestHash = 'project-hash';
		const claim = await idempotency.claim({
			actorId: userId,
			scope: 'project-submit:admin',
			key,
			requestHash,
		});
		if (claim.kind !== 'acquired') throw new Error('Expected to acquire project operation');

		await expect(idempotency.claim({
			actorId: userId,
			scope: 'project-submit:admin',
			key,
			requestHash,
		})).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS', statusCode: 409 });

		const result = await prisma.$transaction(async (tx) => {
			const project = await tx.project.create({
				data: {
					exhibitionId,
					creatorId: userId,
					slug: `idempotent-project-${testId}`,
					title: 'Exactly once project',
				},
			});
			const stored = { projectId: project.id, slug: project.slug };
			await succeedIdempotencyOperation(tx, {
				operationId: claim.operationId,
				ownerToken: claim.ownerToken,
				result: stored,
			});
			return stored;
		});

		await expect(idempotency.claim({
			actorId: userId,
			scope: 'project-submit:admin',
			key,
			requestHash,
		})).resolves.toEqual({ kind: 'succeeded', result });
		await expect(prisma.project.count({
			where: { exhibitionId, slug: `idempotent-project-${testId}` },
		})).resolves.toBe(1);
		await expect(idempotency.claim({
			actorId: userId,
			scope: 'project-submit:admin',
			key,
			requestHash: 'different-project-hash',
		})).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
	});

	it('allows one concurrent asset creator and replays its stored result', async () => {
		const input = {
			actorId: userId,
			scope: `project-asset:${assetProjectId}`,
			key: `asset-${testId}`,
			requestHash: 'asset-file-sha256',
		};
		const attempts = await Promise.allSettled([
			service().claim(input),
			service().claim(input),
		]);
		const acquired = attempts.flatMap((attempt) => (
			attempt.status === 'fulfilled' && attempt.value.kind === 'acquired'
				? [attempt.value]
				: []
		));
		expect(acquired).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
		expect(attempts.find((attempt) => attempt.status === 'rejected'))
			.toMatchObject({ reason: { code: 'OPERATION_IN_PROGRESS', statusCode: 409 } });

		const winner = acquired[0]!;
		const result = await prisma.$transaction(async (tx) => {
			const asset = await tx.asset.create({
				data: {
					projectId: assetProjectId,
					kind: 'IMAGE',
					storageKey: `integration/idempotency/${testId}.png`,
					originalName: 'image.png',
					mimeType: 'image/png',
					sizeBytes: 8n,
					isPublic: true,
				},
			});
			const stored = { assetId: asset.id, url: `/assets/${asset.id}` };
			await succeedIdempotencyOperation(tx, {
				operationId: winner.operationId,
				ownerToken: winner.ownerToken,
				result: stored,
			});
			return stored;
		});

		await expect(service().claim(input)).resolves.toEqual({
			kind: 'succeeded',
			result,
		});
		await expect(prisma.asset.count({
			where: { projectId: assetProjectId, storageKey: `integration/idempotency/${testId}.png` },
		})).resolves.toBe(1);
		await expect(service().claim({ ...input, requestHash: 'other-file-sha256' }))
			.rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
	});
});
