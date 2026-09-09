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
	CanonicalObjectMaterializer,
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
				sourceLegacyAssetKind: sourceAsset?.kind === 'GAME' ? 'GAME' : null,
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
	readonly cleanupIntents = new Map<string, 'PENDING' | 'CANCELLED'>();
	readonly relocations = new Map<string, 'PREPARED' | 'MATERIALIZED' | 'COMMITTED'>();
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
	prepareMaterializationCleanup(target: { bucket: string; objectKey: string }) {
		this.cleanupIntents.set(`${target.bucket}:${target.objectKey}`, 'PENDING');
		return Promise.resolve();
	}
	prepareObjectRelocation(relocation: { copy: { sourceBucket: string; sourceKey: string; destinationBucket: string; destinationKey: string } }) {
		this.relocations.set(`${relocation.copy.sourceBucket}:${relocation.copy.sourceKey}->${relocation.copy.destinationBucket}:${relocation.copy.destinationKey}`, 'PREPARED');
		return Promise.resolve();
	}
	markObjectRelocationMaterialized(relocation: { copy: { sourceBucket: string; sourceKey: string; destinationBucket: string; destinationKey: string } }) {
		this.relocations.set(`${relocation.copy.sourceBucket}:${relocation.copy.sourceKey}->${relocation.copy.destinationBucket}:${relocation.copy.destinationKey}`, 'MATERIALIZED');
		return Promise.resolve();
	}
	private commitRelocations(plan: CanonicalAssetPlan | CanonicalExhibitionPlan) {
		for (const relocation of plan.relocations ?? []) {
			const identity = `${relocation.copy.sourceBucket}:${relocation.copy.sourceKey}->${relocation.copy.destinationBucket}:${relocation.copy.destinationKey}`;
			if (this.relocations.get(identity) !== 'MATERIALIZED' && this.relocations.get(identity) !== 'COMMITTED') {
				throw new Error(`relocation is not materialized: ${identity}`);
			}
			this.relocations.set(identity, 'COMMITTED');
		}
	}
	private commitCleanup(representations: readonly CanonicalRepresentationPlan[]) {
		for (const representation of representations) {
			const identity = `${representation.bucket}:${representation.objectKey}`;
			if (this.cleanupIntents.has(identity)) this.cleanupIntents.set(identity, 'CANCELLED');
		}
	}

	async applyAsset(plan: CanonicalAssetPlan): Promise<CanonicalApplyOutcome> {
		for (const representation of plan.representations) {
			this.representations.set(`${plan.row.id}:${representation.role}`, representation);
		}
		this.commitCleanup(plan.representations);
		this.commitRelocations(plan);
		return { assetsCreated: 0, representationsUpserted: plan.representations.length, deploymentsUpserted: 0 };
	}
	async applyExhibition(plan: CanonicalExhibitionPlan): Promise<CanonicalApplyOutcome> {
		const assetId = plan.row.posterAssetId ?? this.nextAssetId++;
		plan.row.posterAssetId = assetId;
		for (const representation of plan.representations) {
			this.representations.set(`${assetId}:${representation.role}`, representation);
		}
		this.commitCleanup(plan.representations);
		this.commitRelocations(plan);
		return { assetsCreated: 1, representationsUpserted: plan.representations.length, deploymentsUpserted: 0 };
	}
	async applyWebgl(plan: CanonicalWebglPlan): Promise<CanonicalApplyOutcome> {
		plan.row.currentWebglDeploymentId = plan.deploymentId;
		const existingAssetId = plan.row.sourceLegacyAssetKind === 'WEBGL'
			? plan.row.sourceLegacyAssetId
			: null;
		this.representations.set(`${existingAssetId ?? this.nextAssetId++}:WEBGL_SOURCE`, plan.source);
		this.commitCleanup([plan.source]);
		this.deployments.set(plan.deploymentId, plan);
		return { assetsCreated: existingAssetId === null ? 1 : 0, representationsUpserted: 1, deploymentsUpserted: 1 };
	}
}

const buckets = { protectedBucket: 'protected', publicBucket: 'public' };

const materializer: CanonicalObjectMaterializer = {
	async ensureCanonicalObjectCopy(copy, hooks) {
		await hooks?.beforeCreate({
			bucket: copy.destinationBucket, objectKey: copy.destinationKey,
			reason: 'fixture-copy-not-committed',
		});
		return {
			created: true,
			head: { ...copy.expected, checksumSha256: copy.expected.checksumSha256 ?? 'a'.repeat(64) },
		};
	},
	async ensureWebglSourceCopy(copy) {
		return { head: { ...copy.expected, checksumSha256: copy.expected.checksumSha256 ?? 'a'.repeat(64) }, created: true };
	},
	async ensureImageRenditions(repair, hooks) {
		const representations: CanonicalRepresentationPlan[] = [];
		for (const target of repair.missing) {
			await hooks?.beforeCreate({
				bucket: repair.sourceBucket, objectKey: target.objectKey,
				reason: 'fixture-rendition-not-committed',
			});
			representations.push({
				role: target.role, bucket: repair.sourceBucket, objectKey: target.objectKey,
				mimeType: 'image/webp', sizeBytes: 10n, checksumAlgorithm: 'SHA256',
				checksum: '2'.repeat(64), etag: 'fixture-rendition-etag',
				sourceIdentityAlgorithm: 'MIGRATION_GENERATED_SHA256',
				sourceIdentity: '2'.repeat(64), width: target.width, height: target.width / 2,
			});
		}
		return { representations, created: representations.length, reused: 0 };
	},
};

describe('canonical asset backfill', () => {
	it.each([
		['DOCUMENT', 'text/plain'],
		['DOCUMENT', 'application/pdf'],
		['ATTACHMENT', 'application/octet-stream'],
		['VIDEO', 'video/x-matroska'],
		['VIDEO', 'video/x-msvideo'],
	] as const)('preserves protected %s originals (%s) without image repair', async (kind, mimeType) => {
		const row: LegacyAssetRow = {
			...assetRows()[0]!, id: 99001, kind, isPublic: false,
			storageKey: 'corrected-source', mimeType, sizeBytes: 100n,
			playbackStorageKey: null, playbackStatus: 'PENDING',
		};
		const repository = new FakeRepository([row]);
		const repair = vi.fn(materializer.ensureImageRenditions);
		const result = await runCanonicalBackfill({
			repository, verifier: verifier([{
				bucket: 'protected', key: 'corrected-source',
				head: { size: 100n, mimeType, checksumSha256: 'a'.repeat(64) },
			}]), materializer: { ...materializer, ensureImageRenditions: repair }, ...buckets,
			progress: createCanonicalBackfillProgress('apply', fixedDate),
			options: { apply: true, batchSize: 10 }, now: () => fixedDate,
		});
		expect(result.failures).toEqual([]);
		expect(repair).not.toHaveBeenCalled();
		expect(repository.representations.get('99001:ORIGINAL')).toMatchObject({
			bucket: 'protected', mimeType, checksum: 'a'.repeat(64),
		});
		expect(repository.representations.size).toBe(1);
	});

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
		expect(result.stats.representations).toBe(15);
		expect(result.stats.assetsCreated).toBe(2);
		expect(result.stats.repairsPlanned).toBe(3);
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

	it('plans missing image renditions without fake rows and commits only materialized bytes', async () => {
		const row: LegacyAssetRow = {
			...assetRows()[2]!, id: 78, storageKey: 'images/78/source.png', sizeBytes: 100n,
			card480Height: null, display960Height: null,
		};
		const sourceHead = { size: 100n, mimeType: 'image/png', checksumSha256: '1'.repeat(64) };
		const dryRepository = new FakeRepository([row]);
		const dry = await runCanonicalBackfill({
			repository: dryRepository,
			verifier: verifier([{ bucket: 'public', key: row.storageKey!, head: sourceHead }]),
			...buckets, progress: createCanonicalBackfillProgress('dry-run', fixedDate),
			options: { apply: false, batchSize: 10 }, now: () => fixedDate,
		});
		expect(dry.failures).toHaveLength(0);
		expect(dry.stats.repairsPlanned).toBe(2);
		expect(dryRepository.representations.size).toBe(0);

		const repository = new FakeRepository([row]);
		const result = await runCanonicalBackfill({
			repository,
			verifier: verifier([{ bucket: 'public', key: row.storageKey!, head: sourceHead }]),
			materializer: {
				ensureCanonicalObjectCopy: materializer.ensureCanonicalObjectCopy,
				ensureWebglSourceCopy: materializer.ensureWebglSourceCopy,
				async ensureImageRenditions(repair, hooks) {
					for (const target of repair.missing) {
						await hooks?.beforeCreate({ bucket: repair.sourceBucket, objectKey: target.objectKey, reason: 'test-rendition-not-committed' });
					}
					return {
						created: 2, reused: 0,
						representations: repair.missing.map((target) => ({
							role: target.role, bucket: repair.sourceBucket, objectKey: target.objectKey,
							mimeType: 'image/webp', sizeBytes: 10n, checksumAlgorithm: 'SHA256',
							checksum: '2'.repeat(64), etag: 'rendition', sourceIdentityAlgorithm: 'MIGRATION_GENERATED_SHA256',
							sourceIdentity: '2'.repeat(64), width: target.width, height: target.width / 2,
						})),
					};
				},
			},
			...buckets, progress: createCanonicalBackfillProgress('apply', fixedDate),
			options: { apply: true, batchSize: 10 }, now: () => fixedDate,
		});
		expect(result.failures).toHaveLength(0);
		expect(result.stats.imageRepairs).toBe(2);
		expect([...repository.representations.keys()]).toEqual(['78:ORIGINAL', '78:CARD_480', '78:DISPLAY_960']);
		expect([...repository.cleanupIntents.values()]).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
	});

	it('relocates legacy public image representations into deterministic final namespaces and commits the ledger', async () => {
		const row = assetRows().find((asset) => asset.id === 42_003)!;
		const repository = new FakeRepository([row]);
		const result = await runCanonicalBackfill({
			repository, verifier: verifier(), materializer, ...buckets,
			progress: createCanonicalBackfillProgress('apply', fixedDate),
			options: { apply: true, batchSize: 10 }, now: () => fixedDate,
		});

		expect(result.failures).toHaveLength(0);
		expect(result.stats).toMatchObject({ objectCopies: 3, imageRepairs: 0 });
		expect([...repository.representations.values()].map((representation) => representation.objectKey)).toEqual([
			expect.stringMatching(/^public\/images\/42003\/original\/[a-f0-9]{32}\.png$/),
			expect.stringMatching(/^public\/images\/42003\/card_480\/[a-f0-9]{32}\.webp$/),
			expect.stringMatching(/^public\/images\/42003\/display_960\/[a-f0-9]{32}\.webp$/),
		]);
		expect([...repository.relocations.values()]).toEqual(['COMMITTED', 'COMMITTED', 'COMMITTED']);
		expect([...repository.cleanupIntents.values()]).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
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
			sourceLegacyAssetKind: null,
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
			materializer,
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
			sourceLegacyAssetKind: null,
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
			sourceLegacyAssetKind: null,
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

	it('preserves a legacy GAME original while copying WEBGL_SOURCE to a separate WEBGL asset', async () => {
		const repository = new FakeRepository(assetRows(), [], webglRows().slice(0, 1));
		const result = await runCanonicalBackfill({
			repository,
			verifier: verifier(),
			...buckets,
			progress: createCanonicalBackfillProgress('apply', fixedDate),
			options: { apply: true, batchSize: 100 },
			materializer,
			now: () => fixedDate,
		});
		expect(result.failures).toHaveLength(0);
		expect(repository.representations.get('42005:ORIGINAL')?.objectKey).toContain('/source.zip');
		expect(repository.representations.get('42005:WEBGL_SOURCE')).toBeUndefined();
		const webglSource = [...repository.representations.entries()].find(([identity]) => identity.endsWith(':WEBGL_SOURCE'));
		expect(webglSource?.[1].objectKey).toBe(
			`protected/assets/webgl/41022/3f3df944-a7e3-430d-a9c1-915caa2e1d5b/source.zip`,
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

	it('reuses a verified WebGL copy after copy-before-DB failure', async () => {
		const row = webglRows().find((candidate) => candidate.sourceLegacyAssetKind === 'GAME')!;
		const repository = new FakeRepository([], [], [row]);
		const apply = vi.spyOn(repository, 'applyWebgl');
		const original = apply.getMockImplementation()!;
		apply.mockRejectedValueOnce(new Error('injected DB failure')).mockImplementation(original);
		let copied = false;
		const copyOutcomes: boolean[] = [];
		const copyMaterializer: CanonicalObjectMaterializer = {
			ensureCanonicalObjectCopy: materializer.ensureCanonicalObjectCopy,
			async ensureWebglSourceCopy(copy, hooks) {
				const created = !copied;
				if (created) await hooks?.beforeCreate({
					bucket: copy.destinationBucket, objectKey: copy.destinationKey,
					reason: 'test-copy-not-committed',
				});
				copied = true;
				copyOutcomes.push(created);
				return { created, head: { ...copy.expected, checksumSha256: copy.expected.checksumSha256 ?? '4'.repeat(64) } };
			},
			ensureImageRenditions: materializer.ensureImageRenditions,
		};
		const first = await runCanonicalBackfill({
			repository, verifier: verifier(), materializer: copyMaterializer, ...buckets,
			progress: createCanonicalBackfillProgress('apply', fixedDate),
			options: { apply: true, batchSize: 10 }, now: () => fixedDate,
		});
		expect(first.failures).toHaveLength(1);
		const destinationIdentity = `protected:protected/assets/webgl/${row.id}/${row.sourceProof!.deploymentId}/source.zip`;
		expect(repository.cleanupIntents.get(destinationIdentity)).toBe('PENDING');
		const rerun = await runCanonicalBackfill({
			repository, verifier: verifier(), materializer: copyMaterializer, ...buckets,
			progress: first.progress, options: { apply: true, batchSize: 10 }, now: () => fixedDate,
		});
		expect(rerun.failures).toHaveLength(0);
		expect(copyOutcomes).toEqual([true, false]);
		expect(repository.cleanupIntents.get(destinationIdentity)).toBe('CANCELLED');
		expect(repository.deployments.has(row.sourceProof!.deploymentId)).toBe(true);
	});

	it('reuses verified renditions and cancels their cleanup intents after an object-before-DB crash', async () => {
		const row: LegacyAssetRow = {
			...assetRows()[2]!, id: 79, storageKey: 'images/79/source.png', sizeBytes: 100n,
			card480Height: null, display960Height: null,
		};
		const repository = new FakeRepository([row]);
		const apply = vi.spyOn(repository, 'applyAsset');
		const original = apply.getMockImplementation()!;
		apply.mockRejectedValueOnce(new Error('injected DB failure')).mockImplementation(original);
		const created = new Set<string>();
		const materializationCounts: Array<{ created: number; reused: number }> = [];
		const repairMaterializer: CanonicalObjectMaterializer = {
			ensureCanonicalObjectCopy: materializer.ensureCanonicalObjectCopy,
			ensureWebglSourceCopy: materializer.ensureWebglSourceCopy,
			async ensureImageRenditions(repair, hooks) {
				let createdCount = 0;
				let reused = 0;
				const representations = [] as CanonicalRepresentationPlan[];
				for (const target of repair.missing) {
					const identity = `${repair.sourceBucket}:${target.objectKey}`;
					if (!created.has(identity)) {
						await hooks?.beforeCreate({
							bucket: repair.sourceBucket, objectKey: target.objectKey,
							reason: 'test-rendition-not-committed',
						});
						created.add(identity);
						createdCount += 1;
					} else reused += 1;
					representations.push({
						role: target.role, bucket: repair.sourceBucket, objectKey: target.objectKey,
						mimeType: 'image/webp', sizeBytes: 10n, checksumAlgorithm: 'SHA256',
						checksum: '2'.repeat(64), etag: 'rendition',
						sourceIdentityAlgorithm: 'MIGRATION_GENERATED_SHA256',
						sourceIdentity: '2'.repeat(64), width: target.width, height: target.width / 2,
					});
				}
				materializationCounts.push({ created: createdCount, reused });
				return { representations, created: createdCount, reused };
			},
		};
		const sourceVerifier = verifier([{
			bucket: 'public', key: row.storageKey!,
			head: { size: 100n, mimeType: 'image/png', checksumSha256: '1'.repeat(64) },
		}]);
		const first = await runCanonicalBackfill({
			repository, verifier: sourceVerifier, materializer: repairMaterializer, ...buckets,
			progress: createCanonicalBackfillProgress('apply', fixedDate),
			options: { apply: true, batchSize: 10 }, now: () => fixedDate,
		});
		expect(first.failures).toHaveLength(1);
		expect([...repository.cleanupIntents.values()]).toEqual(['PENDING', 'PENDING', 'PENDING']);
		const rerun = await runCanonicalBackfill({
			repository, verifier: sourceVerifier, materializer: repairMaterializer, ...buckets,
			progress: first.progress, options: { apply: true, batchSize: 10 }, now: () => fixedDate,
		});
		expect(rerun.failures).toHaveLength(0);
		expect(materializationCounts).toEqual([{ created: 2, reused: 0 }, { created: 0, reused: 2 }]);
		expect([...repository.cleanupIntents.values()]).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
		expect(repository.representations.size).toBe(3);
	});

	it('parses dry-run/apply and bounded batch options', () => {
		expect(parseCanonicalBackfillOptions([])).toEqual({ apply: false, batchSize: 100 });
		expect(parseCanonicalBackfillOptions(['--apply', '--batch-size=25'])).toEqual({ apply: true, batchSize: 25 });
		expect(parseCanonicalBackfillOptions(['--report-file=/tmp/report.json'])).toEqual({ apply: false, batchSize: 100 });
		expect(() => parseCanonicalBackfillOptions(['--batch-size=0'])).toThrow(/between 1 and 1000/);
		expect(() => parseCanonicalBackfillOptions(['--unknown'])).toThrow(/Unknown/);
	});
});
