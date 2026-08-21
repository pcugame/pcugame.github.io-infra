import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createCanonicalBackfillRepository } from '../modules/migration/canonical-backfill.prisma.js';

const deploymentId = '3f3df944-a7e3-430d-a9c1-915caa2e1d5b';
const project = {
	id: 9,
	webglEntryKey: `webgl/9/${deploymentId}/site/index.html`,
	currentWebglDeploymentId: null,
	updatedAt: new Date('2026-08-21T00:00:00.000Z'),
};

function session(id: string, storageKey: string, updatedAt: string) {
	return {
		id, storageKey, s3Key: storageKey, originalName: 'webgl.zip', totalBytes: 100n,
		completionResult: { status: 'COMPLETED', storageKey, sizeBytes: 100 },
		updatedAt: new Date(updatedAt),
	};
}

function repositoryFor(sessions: ReturnType<typeof session>[]) {
	const client = {
		project: { findMany: vi.fn(async () => [project]) },
		gameUploadSession: { findMany: vi.fn(async () => sessions) },
		asset: { findUnique: vi.fn(async () => null) },
	} as unknown as PrismaClient;
	return createCanonicalBackfillRepository(client);
}

describe('legacy WebGL source proof', () => {
	it('matches the entry generation instead of choosing the newest completed session', async () => {
		const exact = `webgl/9/${deploymentId}/source.zip`;
		const unrelated = 'webgl/9/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/source.zip';
		const [row] = await repositoryFor([
			session('newest-unrelated', unrelated, '2026-08-21T02:00:00.000Z'),
			session('older-exact', exact, '2026-08-21T01:00:00.000Z'),
		]).listWebglProjects(0, 10);
		expect(row?.sourceProof).toMatchObject({ sessionId: 'older-exact', deploymentId, storageKey: exact });
	});

	it('returns SOURCE_NOT_PROVEN input when exact proof is ambiguous or completion metadata disagrees', async () => {
		const exact = `webgl/9/${deploymentId}/source.zip`;
		const [ambiguous] = await repositoryFor([
			session('one', exact, '2026-08-21T01:00:00.000Z'),
			session('two', exact, '2026-08-21T02:00:00.000Z'),
		]).listWebglProjects(0, 10);
		expect(ambiguous?.sourceProof).toBeNull();
		const malformed = session('bad-size', exact, '2026-08-21T01:00:00.000Z');
		malformed.completionResult.sizeBytes = 99;
		const [unproven] = await repositoryFor([malformed]).listWebglProjects(0, 10);
		expect(unproven?.sourceProof).toBeNull();
	});
});
