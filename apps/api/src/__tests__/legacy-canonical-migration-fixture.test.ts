import { describe, expect, it, vi } from 'vitest';
import {
	legacyCanonicalMigrationExpected,
	legacyCanonicalMigrationFixture,
	legacyCanonicalMigrationObjectInventory,
	loadLegacyCanonicalMigrationFixture,
} from './fixtures/legacy-canonical-migration.js';

describe('legacy canonical migration fixture', () => {
	it('covers the master user-visible asset, rendition, terminal-state, and WebGL shapes', () => {
		const { assets, projects, exhibitions, gameUploadSessions } = legacyCanonicalMigrationFixture;
		const webglSourceKey = legacyCanonicalMigrationExpected.representations.find((representation) => (
			representation.legacyAssetId === 42_005 && representation.role === 'ORIGINAL'
		))!.key;
		expect(assets.map((asset) => asset.kind)).toEqual(expect.arrayContaining([
			'GAME', 'VIDEO', 'POSTER', 'IMAGE',
		]));
		expect(assets).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: 'VIDEO', playbackStorageKey: expect.any(String), playbackStatus: 'READY' }),
			expect.objectContaining({ kind: 'POSTER', card480Height: expect.any(Number), display960Height: expect.any(Number) }),
			expect.objectContaining({ kind: 'IMAGE', card480Height: expect.any(Number), display960Height: expect.any(Number) }),
			expect.objectContaining({ status: 'DELETED' }),
			expect.objectContaining({ status: 'FAILED' }),
		]));
		expect(projects.map((project) => project.status)).toEqual(expect.arrayContaining(['PUBLISHED', 'ARCHIVED']));
		expect(projects).toEqual(expect.arrayContaining([
			expect.objectContaining({ webglEntryKey: legacyCanonicalMigrationExpected.webglDeployment.legacyEntryKey }),
			expect.objectContaining({
				id: legacyCanonicalMigrationExpected.unresolvedWebglDeployment.projectId,
				webglEntryKey: legacyCanonicalMigrationExpected.unresolvedWebglDeployment.legacyEntryKey,
			}),
		]));
		expect(gameUploadSessions).toEqual([
			expect.objectContaining({
				id: legacyCanonicalMigrationExpected.webglDeployment.sourceUploadSessionId,
				uploadKind: 'WEBGL',
				status: 'COMPLETED',
				storageKey: webglSourceKey,
				s3Key: webglSourceKey,
				completionResult: expect.objectContaining({ status: 'COMPLETED', sizeBytes: 6_291_456 }),
			}),
		]);
		expect(exhibitions[0]).toMatchObject({ posterStorageKey: expect.any(String), posterCard480Height: expect.any(Number) });
	});

	it('has a HEAD record for every representation that must survive Phase 1', () => {
		const inventory = new Set(legacyCanonicalMigrationObjectInventory.map((object) => `${object.bucket}:${object.key}`));
		for (const representation of legacyCanonicalMigrationExpected.representations) {
			expect(inventory).toContain(`${representation.bucket}:${representation.key}`);
		}
		for (const representation of legacyCanonicalMigrationExpected.exhibitionPoster.representations) {
			expect(inventory).toContain(`${representation.bucket}:${representation.key}`);
		}
		for (const object of legacyCanonicalMigrationObjectInventory) {
			expect(object.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
			expect(object.size).toBeGreaterThan(0n);
		}
	});

	it('is repeat-loadable through deterministic upserts and attaches the poster only after its asset exists', async () => {
		const calls: Array<{ model: string; input: { where: { id: number }; create: Record<string, unknown>; update: Record<string, unknown> } }> = [];
		const delegate = (model: string) => ({ upsert: vi.fn(async (input) => { calls.push({ model, input }); }) });
		const client = {
			user: delegate('user'), exhibition: delegate('exhibition'), project: delegate('project'), asset: delegate('asset'),
			gameUploadSession: delegate('gameUploadSession'),
		};

		await loadLegacyCanonicalMigrationFixture(client);
		await loadLegacyCanonicalMigrationFixture(client);

		expect(calls).toHaveLength((1 + 1 + 3 + 7 + 1 + 3) * 2);
		expect(calls.every((call) => typeof call.input.where.id === 'number' || typeof call.input.where.id === 'string')).toBe(true);
		const firstPosterPointer = calls.findIndex((call) => call.model === 'project' && call.input.update.posterAssetId === 42_003);
		const firstPosterAsset = calls.findIndex((call) => call.model === 'asset' && call.input.where.id === 42_003);
		expect(firstPosterPointer).toBeGreaterThan(firstPosterAsset);
		const firstWebglSession = calls.findIndex((call) => call.model === 'gameUploadSession');
		const firstWebglPointer = calls.findIndex((call) => call.model === 'project' && call.input.update.webglEntryKey === legacyCanonicalMigrationExpected.webglDeployment.legacyEntryKey);
		expect(firstWebglSession).toBeGreaterThan(-1);
		expect(firstWebglPointer).toBeGreaterThan(firstWebglSession);
	});
});
