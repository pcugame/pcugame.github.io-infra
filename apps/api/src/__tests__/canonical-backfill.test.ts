import { describe, expect, it, vi } from 'vitest';
import {
	legacyCanonicalMigrationFixture,
	legacyCanonicalMigrationObjectInventory,
} from './fixtures/legacy-canonical-migration.js';
import {
	createCanonicalBackfillProgress,
	parseCanonicalBackfillOptions,
	runCanonicalBackfill,
} from '../modules/migration/canonical-backfill.js';
import type {
	CanonicalApplyOutcome,
	CanonicalAssetPlan,
	CanonicalBackfillRepository,
	CanonicalExhibitionPlan,
	CanonicalRepresentationPlan,
	CanonicalWebglPlan,
	LegacyAssetRow,
	LegacyExhibitionRow,
	LegacyWebglRow,
	ObjectHeadRecord,
} from '../modules/migration/canonical-backfill.types.js';

const fixedDate = new Date('2026-08-21T00:00:00.000Z');

function assetRows(): LegacyAssetRow[] {
	return legacyCanonicalMigrationFixture.assets.map((asset) => ({
		...asset,
		exhibitionId: null,
		updatedAt: fixedDate,
	}));
}

function exhibitionRows(): LegacyExhibitionRow[] {
	return legacyCanonicalMigrationFixture.exhibitions.map((exhibition) => ({
		...exhibition,
		posterAssetId: null,
		updatedAt: fixedDate,
	}));
}

function webglRows(): LegacyWebglRow[] {
	return legacyCanonicalMigrationFixture.projects
		.filter((project) => project.webglEntryKey)
		.map((project) => {
			const source = legacyCanonicalMigrationFixture.gameUploadSessions.find((session) => session.projectId === project.id);
			const sourceAsset = source
				? legacyCanonicalMigrationFixture.assets.find((asset) => asset.storageKey === source.storageKey)
				: undefined;
			return {
			id: project.id,
			webglEntryKey: project.webglEntryKey,
			currentWebglDeploymentId: null,
			updatedAt: fixedDate,
			sourceProof: source ? {
				sessionId: source.id, storageKey: source.storageKey,
				deploymentId: project.webglEntryKey.split('/')[2]!,
				originalName: source.originalName, totalBytes: source.totalBytes, updatedAt: fixedDate,
			} : null,
			sourceLegacyAssetId: sourceAsset?.id ?? null,
			};
		});
}

function verifier(extra: Array<{ bucket: string; key: string; head: ObjectHeadRecord }> = []) {
	const inventory = new Map<string, ObjectHeadRecord>();
	for (const object of legacyCanonicalMigrationObjectInventory) {
		inventory.set(`${object.bucket}:${object.key}`, {
			size: object.size,
			mimeType: object.mimeType,
			etag: object.etag,
			checksumSha256: object.checksumSha256,
		});
	}
	for (const object of extra) inventory.set(`${object.bucket}:${object.key}`, object.head);
	return {
		head: vi.fn(async (bucket: string, key: string) => inventory.get(`${bucket}:${key}`) ?? null),
		listPrefix: vi.fn(async (bucket: string, prefix: string, afterKey: string | undefined, limit: number) => {
			const keys = [...inventory.keys()]
				.map((identity) => {
					const separator = identity.indexOf(':');
					return { bucket: identity.slice(0, separator), key: identity.slice(separator + 1) };
				})
				.filter((object) => object.bucket === bucket && object.key.startsWith(prefix)
					&& (afterKey === undefined || Buffer.compare(Buffer.from(object.key), Buffer.from(afterKey)) > 0))
				.sort((left, right) => Buffer.compare(Buffer.from(left.key), Buffer.from(right.key)))
				.map((object) => object.key);
			return { keys: keys.slice(0, limit), isTruncated: keys.length > limit };
		}),
	};
}

class FakeRepository implements CanonicalBackfillRepository {
	readonly representations = new Map<string, CanonicalRepresentationPlan>();
	readonly deployments = new Map<string, CanonicalWebglPlan>();
	private nextAssetId = 90_000;

	constructor(
		readonly assets: LegacyAssetRow[] = [],
		readonly exhibitions: LegacyExhibitionRow[] = [],
		readonly webgl: LegacyWebglRow[] = [],
	) {}

	listAssets(afterId: number, limit: number) {
		return Promise.resolve(this.assets.filter((row) => row.id > afterId).slice(0, limit));
	}
	listExhibitions(afterId: number, limit: number) {
		return Promise.resolve(this.exhibitions.filter((row) => row.id > afterId).slice(0, limit));
	}
	listWebglProjects(afterId: number, limit: number) {
		return Promise.resolve(this.webgl.filter((row) => row.id > afterId).slice(0, limit));
	}
	getAsset(id: number) { return Promise.resolve(this.assets.find((row) => row.id === id) ?? null); }
	getExhibition(id: number) { return Promise.resolve(this.exhibitions.find((row) => row.id === id) ?? null); }
	getWebglProject(id: number) { return Promise.resolve(this.webgl.find((row) => row.id === id) ?? null); }

	async applyAsset(plan: CanonicalAssetPlan): Promise<CanonicalApplyOutcome> {
		for (const representation of plan.representations) {
			this.representations.set(`${plan.row.id}:${representation.role}`, representation);
		}
		return { assetsCreated: 0, representationsUpserted: plan.representations.length, deploymentsUpserted: 0 };
	}
	async applyExhibition(plan: CanonicalExhibitionPlan): Promise<CanonicalApplyOutcome> {
		const assetId = plan.row.posterAssetId ?? this.nextAssetId++;
		plan.row.posterAssetId = assetId;
		for (const representation of plan.representations) {
			this.representations.set(`${assetId}:${representation.role}`, representation);
		}
		return { assetsCreated: 1, representationsUpserted: plan.representations.length, deploymentsUpserted: 0 };
	}
	async applyWebgl(plan: CanonicalWebglPlan): Promise<CanonicalApplyOutcome> {
		plan.row.currentWebglDeploymentId = plan.deploymentId;
		const existingAssetId = plan.row.sourceLegacyAssetId;
		this.representations.set(`${existingAssetId ?? this.nextAssetId++}:WEBGL_SOURCE`, plan.source);
		this.deployments.set(plan.deploymentId, plan);
		return { assetsCreated: existingAssetId === null ? 1 : 0, representationsUpserted: 1, deploymentsUpserted: 1 };
	}
}

const buckets = { protectedBucket: 'protected', publicBucket: 'public' };

describe('canonical asset backfill', () => {
	it('migrates the proven WebGL source and isolates the malformed unproven pointer', async () => {
		const repository = new FakeRepository(assetRows(), exhibitionRows(), webglRows());
		const result = await runCanonicalBackfill({
			repository,
			verifier: verifier(),
			...buckets,
			progress: createCanonicalBackfillProgress('dry-run', fixedDate),
			options: { apply: false, batchSize: 2 },
			now: () => fixedDate,
		});

		expect(result.progress.phase).toBe('done');
		expect(result.stats.representations).toBe(14);
		expect(result.stats.assetsCreated).toBe(1);
		expect(result.stats.deployments).toBe(1);
		expect(result.failures).toEqual([
			expect.objectContaining({ ref: { kind: 'webgl', id: 41_023 }, code: 'MALFORMED_LEGACY_ROW' }),
		]);
	});

	it('supports semantic PLAYBACK aliasing when the original is browser-playable', async () => {
		const row: LegacyAssetRow = {
			...assetRows()[1]!,
			id: 77,
			storageKey: 'video/77/original.mp4',
			playbackStorageKey: null,
			mimeType: 'video/mp4',
			playbackMimeType: '',
			sizeBytes: 123n,
			playbackSizeBytes: 0n,
			playbackStatus: 'READY',
		};
		const repository = new FakeRepository([row]);
		const head = { size: 123n, mimeType: 'video/mp4', etag: 'video-77' };
		const result = await runCanonicalBackfill({
			repository,
			verifier: verifier([{ bucket: 'protected', key: row.storageKey!, head }]),
			...buckets,
			progress: createCanonicalBackfillProgress('apply', fixedDate),
			options: { apply: true, batchSize: 10 },
			now: () => fixedDate,
		});

		expect(result.failures).toHaveLength(0);
		expect(repository.representations.get('77:ORIGINAL')?.objectKey).toBe(row.storageKey);
		expect(repository.representations.get('77:PLAYBACK')?.objectKey).toBe(row.storageKey);
	});

	it('isolates missing, ambiguous, and malformed rows while advancing the keyset cursor', async () => {
		const [base] = assetRows();
		const missing = { ...base!, id: 1, storageKey: 'missing.zip' };
		const ambiguous = { ...base!, id: 2, storageKey: 'ambiguous.zip', sizeBytes: 5n };
		const malformed = { ...base!, id: 3, storageKey: '../unsafe.zip' };
		const head = { size: 5n, mimeType: 'application/zip', etag: 'same' };
		const result = await runCanonicalBackfill({
			repository: new FakeRepository([missing, ambiguous, malformed]),
			verifier: verifier([
				{ bucket: 'protected', key: 'ambiguous.zip', head },
				{ bucket: 'public', key: 'ambiguous.zip', head },
			]),
			...buckets,
			progress: createCanonicalBackfillProgress('dry-run', fixedDate),
			options: { apply: false, batchSize: 2 },
			now: () => fixedDate,
		});

		expect(result.progress.phase).toBe('done');
		expect(result.failures.map((failure) => failure.code)).toEqual([
			'MISSING_OBJECT', 'AMBIGUOUS_OBJECT', 'MALFORMED_LEGACY_ROW',
		]);
	});

	it('creates a WebGL asset only when an exact completed source locator proves it', async () => {
		const deploymentId = 'd45bc040-c204-4cc7-8c91-ad4b70d5f9e4';
		const sourceKey = `webgl/88/${deploymentId}/source.zip`;
		const entryKey = `webgl/88/${deploymentId}/site/index.html`;
		const webgl: LegacyWebglRow = {
			id: 88,
			webglEntryKey: entryKey,
			currentWebglDeploymentId: null,
			updatedAt: fixedDate,
			sourceProof: {
				sessionId: 'completed-webgl-session', storageKey: sourceKey,
				deploymentId,
				originalName: 'source.zip', totalBytes: 10n, updatedAt: fixedDate,
			},
			sourceLegacyAssetId: null,
		};
		const repository = new FakeRepository([], [], [webgl]);
		const result = await runCanonicalBackfill({
			repository,
			verifier: verifier([
				{ bucket: 'protected', key: sourceKey, head: { size: 10n, mimeType: 'application/zip', etag: 'source' } },
				{ bucket: 'public', key: entryKey, head: { size: 20n, mimeType: 'text/html', etag: 'entry' } },
			]),
			...buckets,
			progress: createCanonicalBackfillProgress('apply', fixedDate),
			options: { apply: true, batchSize: 10 },
			now: () => fixedDate,
		});

		expect(result.failures).toHaveLength(0);
		expect(repository.deployments.get(deploymentId)).toMatchObject({
			publicPrefix: `webgl/88/${deploymentId}/site/`,
			entryObjectKey: entryKey,
			objectManifest: { version: 1, objects: [expect.objectContaining({ objectKey: entryKey })] },
		});
	});

	it('reports SOURCE_NOT_PROVEN for a valid generation without deterministic session proof', async () => {
		const deploymentId = 'd45bc040-c204-4cc7-8c91-ad4b70d5f9e4';
		const repository = new FakeRepository([], [], [{
			id: 88,
			webglEntryKey: `webgl/88/${deploymentId}/site/index.html`,
			currentWebglDeploymentId: null,
			updatedAt: fixedDate,
			sourceProof: null,
			sourceLegacyAssetId: null,
		}]);
		const result = await runCanonicalBackfill({
			repository, verifier: verifier(), ...buckets,
			progress: createCanonicalBackfillProgress('dry-run', fixedDate),
			options: { apply: false, batchSize: 10 }, now: () => fixedDate,
		});
		expect(result.failures).toEqual([
			expect.objectContaining({ ref: { kind: 'webgl', id: 88 }, code: 'SOURCE_NOT_PROVEN' }),
		]);
	});

	it('rejects a WebGL prefix adapter that exceeds the bounded page contract', async () => {
		const deploymentId = 'd45bc040-c204-4cc7-8c91-ad4b70d5f9e4';
		const sourceKey = `webgl/88/${deploymentId}/source.zip`;
		const row: LegacyWebglRow = {
			id: 88, webglEntryKey: `webgl/88/${deploymentId}/site/index.html`,
			currentWebglDeploymentId: null, updatedAt: fixedDate,
			sourceProof: { sessionId: 's', deploymentId, storageKey: sourceKey, originalName: 'source.zip', totalBytes: 10n, updatedAt: fixedDate },
			sourceLegacyAssetId: null,
		};
		const repository = new FakeRepository([], [], [row]);
		const result = await runCanonicalBackfill({
			repository,
			verifier: {
				head: vi.fn(async (bucket, key) => bucket === 'protected' && key === sourceKey
					? { size: 10n, mimeType: 'application/zip' }
					: null),
				listPrefix: vi.fn(async (_bucket, prefix, _after, limit) => ({
					keys: Array.from({ length: limit + 1 }, (_, index) => `${prefix}${index}.bin`),
					isTruncated: true,
				})),
			},
			...buckets,
			progress: createCanonicalBackfillProgress('dry-run', fixedDate),
			options: { apply: false, batchSize: 10 }, now: () => fixedDate,
		});
		expect(result.failures[0]).toMatchObject({ code: 'MALFORMED_LEGACY_ROW' });
	});

	it('preserves a legacy GAME original while adding WEBGL_SOURCE on the same asset', async () => {
		const repository = new FakeRepository(assetRows(), [], webglRows().slice(0, 1));
		const result = await runCanonicalBackfill({
			repository,
			verifier: verifier(),
			...buckets,
			progress: createCanonicalBackfillProgress('apply', fixedDate),
			options: { apply: true, batchSize: 100 },
			now: () => fixedDate,
		});
		expect(result.failures).toHaveLength(0);
		expect(repository.representations.get('42005:ORIGINAL')?.objectKey).toContain('/source.zip');
		expect(repository.representations.get('42005:WEBGL_SOURCE')?.objectKey).toBe(
			repository.representations.get('42005:ORIGINAL')?.objectKey,
		);
		const entryKey = legacyCanonicalMigrationFixture.projects[1]!.webglEntryKey;
		expect([...repository.deployments.values()][0]?.objectManifest.objects.map((object) => object.objectKey)).toEqual(
			expect.arrayContaining([
				entryKey,
				entryKey.replace('index.html', 'Build/game.loader.js'),
				entryKey.replace('index.html', 'Build/game.wasm.br'),
			]),
		);
	});

	it('converges after a crash between row commit and cursor persistence', async () => {
		const row = assetRows()[0]!;
		const repository = new FakeRepository([row]);
		const initial = createCanonicalBackfillProgress('apply', fixedDate);
		await expect(runCanonicalBackfill({
			repository,
			verifier: verifier(),
			...buckets,
			progress: initial,
			options: { apply: true, batchSize: 10 },
			now: () => fixedDate,
			afterApplyCommit: async () => { throw new Error('injected process crash'); },
		})).rejects.toThrow('injected process crash');
		expect(repository.representations.size).toBe(1);

		const rerun = await runCanonicalBackfill({
			repository,
			verifier: verifier(),
			...buckets,
			progress: initial,
			options: { apply: true, batchSize: 10 },
			now: () => fixedDate,
		});
		expect(rerun.failures).toHaveLength(0);
		expect(repository.representations.size).toBe(1);
	});

	it('parses dry-run/apply and bounded batch options', () => {
		expect(parseCanonicalBackfillOptions([])).toEqual({ apply: false, batchSize: 100 });
		expect(parseCanonicalBackfillOptions(['--apply', '--batch-size=25'])).toEqual({ apply: true, batchSize: 25 });
		expect(() => parseCanonicalBackfillOptions(['--batch-size=0'])).toThrow(/between 1 and 1000/);
		expect(() => parseCanonicalBackfillOptions(['--unknown'])).toThrow(/Unknown/);
	});
});
