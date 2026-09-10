import { describe, expect, it, vi } from 'vitest';
import {
	CONTRACT_PREFLIGHT_RESET_CONFIRMATION,
	LEGACY_BRIDGE_METRIC_NAMES,
	runContractPreflight,
	type ContractPreflightSnapshot,
	type ContractHead,
} from '../modules/migration/contract-preflight.js';

const now = () => new Date('2026-08-21T00:00:00.000Z');
const objectMetadata = {
	mimeType: 'application/octet-stream', sizeBytes: 1n,
	publicationBucket: null, publicationObjectKey: null,
	checksumAlgorithm: null, checksum: null, etag: 'fixture-etag',
	sourceIdentityAlgorithm: null, sourceIdentity: null,
};
const baseSnapshot = (): ContractPreflightSnapshot => ({
	assets: [{
		id: 1, projectId: 10, exhibitionId: null,
		kind: 'GAME', status: 'READY', storageKey: 'protected/assets/1/original/g1.zip',
		playbackStorageKey: null, playbackStatus: 'PENDING',
		card480Height: null, display960Height: null,
		representations: [{ id: 'r1', assetId: 1, role: 'ORIGINAL', bucket: 'protected', objectKey: 'protected/assets/1/original/g1.zip', state: 'READY', ...objectMetadata }],
	}],
	exhibitions: [], projects: [], deployments: [],
	metrics: LEGACY_BRIDGE_METRIC_NAMES.map((name) => ({
		name, scope: '', value: 0n, lastObservedAt: new Date('2026-08-19T00:00:00.000Z'),
	})),
	uploadSessions: [], cleanupTasks: [],
	storageBuckets: [
		{ bucket: 'protected', visibility: 'PROTECTED' },
		{ bucket: 'public', visibility: 'PUBLIC' },
	],
	relocations: [],
});

function headForSnapshot(snapshot: ContractPreflightSnapshot): ContractHead {
	return vi.fn(async (bucket, key) => {
		for (const asset of snapshot.assets) {
			const representation = asset.representations.find((candidate) => candidate.bucket === bucket && candidate.objectKey === key);
			if (representation) return {
				sizeBytes: representation.sizeBytes, mimeType: representation.mimeType,
				etag: representation.etag, checksumSha256: representation.checksum,
			};
		}
		for (const deployment of snapshot.deployments) {
			if (deployment.publicBucket !== bucket || !deployment.objectManifest || typeof deployment.objectManifest !== 'object') continue;
			const objects = (deployment.objectManifest as { objects?: Array<Record<string, unknown>> }).objects ?? [];
			const object = objects.find((candidate) => candidate['objectKey'] === key);
			if (object) return {
				sizeBytes: BigInt(object['sizeBytes'] as string), mimeType: object['mimeType'] as string,
				etag: object['etag'] as string | null, checksumSha256: object['checksumSha256'] as string | null,
			};
		}
		return null;
	});
}

async function audit(snapshot = baseSnapshot(), inventory = [{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' }], head: ContractHead = headForSnapshot(snapshot), options = {}) {
	const repository = { readSnapshot: vi.fn(async () => snapshot), resetLegacyBridgeObservations: vi.fn(async () => undefined) };
	const report = await runContractPreflight({ repository, inventory: { identity: 'fixture-inventory', capturedAt: now().toISOString(), objects: inventory, multipartUploads: [] }, head, now, options });
	return { report, repository, head };
}

function addImageProject(snapshot: ContractPreflightSnapshot, status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED') {
	const projectId = 30;
	const assetId = 31;
	const stagingId = '11111111-1111-4111-8111-111111111111';
	snapshot.projects.push({ id: projectId, status, webglEntryKey: '', currentWebglDeploymentId: null, currentWebglDeployment: null });
	const staged = status === 'DRAFT';
	snapshot.assets.push({
		id: assetId, projectId, exhibitionId: null, kind: 'IMAGE', status: 'READY',
		storageKey: null, playbackStorageKey: null, playbackStatus: 'PENDING',
		card480Height: 320, display960Height: 640,
		representations: (['ORIGINAL', 'CARD_480', 'DISPLAY_960'] as const).map((role) => ({
			id: `publication-${role.toLowerCase()}`, assetId, role, state: 'READY',
			bucket: staged ? 'protected' : 'public',
			objectKey: staged
				? `protected/publication-staging/projects/${projectId}/images/${stagingId}/${role.toLowerCase()}/1.webp`
				: `public/images/${assetId}/${role.toLowerCase()}/stable.webp`,
			publicationBucket: staged ? 'public' : null,
			publicationObjectKey: staged ? `public/images/${assetId}/${role.toLowerCase()}/stable.webp` : null,
			mimeType: 'image/webp', sizeBytes: 1n, checksumAlgorithm: 'SHA256', checksum: 'a'.repeat(64),
			etag: 'fixture-etag', sourceIdentityAlgorithm: 'SHA256_BLOCK_MANIFEST_V1',
			sourceIdentity: 'a'.repeat(64), width: null, height: null,
		})),
	});
	return snapshot.assets.at(-1)!;
}

describe('canonical contract preflight', () => {
	it('is clean for a fully owned ready representation and excludes terminal assets', async () => {
		const snapshot = baseSnapshot();
		snapshot.assets.push({ id: 2, projectId: 10, exhibitionId: null, kind: 'IMAGE', status: 'DELETED', storageKey: 'deleted', playbackStorageKey: null, playbackStatus: 'PENDING', card480Height: null, display960Height: null, representations: [] });
		const { report } = await audit(snapshot);
		expect(report.clean).toBe(true);
		expect(report.counts).toMatchObject({
			legacyRowsTotal: 2, legacyRowsTerminal: 1, backfilledCanonicalRows: 1,
			verifiedCanonicalObjects: 1, verifiedRelocationSources: 0, unresolvedRows: 0, orphanObjects: 0,
		});
	});

	it('reports cumulative final-state copy/rendition/canonical counts instead of per-run work stats', async () => {
		const snapshot = baseSnapshot();
		const copied = snapshot.assets[0]!.representations[0]!;
		copied.checksumAlgorithm = 'SHA256';
		copied.checksum = 'a'.repeat(64);
		copied.sourceIdentityAlgorithm = 'MIGRATION_COPY_SHA256';
		copied.sourceIdentity = 'a'.repeat(64);
		snapshot.assets.push({
			id: 2, projectId: 10, exhibitionId: null, kind: 'IMAGE', status: 'READY',
			storageKey: null, playbackStorageKey: null, playbackStatus: 'PENDING',
			card480Height: null, display960Height: null,
			representations: [
				{ id: 'image-original', assetId: 2, role: 'ORIGINAL', bucket: 'public', objectKey: 'public/images/2/original/g.png', state: 'READY', ...objectMetadata },
				{ id: 'image-card', assetId: 2, role: 'CARD_480', bucket: 'public', objectKey: 'public/images/2/card_480/g.webp', state: 'READY', ...objectMetadata, checksumAlgorithm: 'SHA256', checksum: 'b'.repeat(64), sourceIdentityAlgorithm: 'MIGRATION_GENERATED_SHA256', sourceIdentity: 'b'.repeat(64) },
				{ id: 'image-display', assetId: 2, role: 'DISPLAY_960', bucket: 'public', objectKey: 'public/images/2/display_960/g.webp', state: 'READY', ...objectMetadata, checksumAlgorithm: 'SHA256', checksum: 'c'.repeat(64), sourceIdentityAlgorithm: 'MIGRATION_GENERATED_SHA256', sourceIdentity: 'c'.repeat(64) },
			],
		});
		const inventory = [
			{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' },
			{ bucket: 'public', key: 'public/images/2/original/g.png' },
			{ bucket: 'public', key: 'public/images/2/card_480/g.webp' },
			{ bucket: 'public', key: 'public/images/2/display_960/g.webp' },
		];
		const report = (await audit(snapshot, inventory)).report;
		expect(report.clean).toBe(true);
			expect(report.counts).toEqual({
			legacyRowsTotal: 1,
			legacyRowsTerminal: 0,
			backfilledCanonicalRows: 2,
			verifiedCanonicalObjects: 4,
			verifiedRelocationSources: 0,
			physicalCopies: 1,
			generatedRenditions: 2,
			unresolvedRows: 0,
			orphanObjects: 0,
			duplicateOwnership: 0,
			legacyFallbackReads: 0,
		});
	});

	it.each([
		['legacyOnlyActiveAssets', (snapshot: ContractPreflightSnapshot) => { snapshot.assets[0]!.representations = []; }],
		['unresolvedRepresentations', (snapshot: ContractPreflightSnapshot) => { snapshot.assets[0]!.representations[0]!.state = 'FAILED'; }],
		['playbackOrphans', (snapshot: ContractPreflightSnapshot) => { snapshot.assets[0] = { ...snapshot.assets[0]!, kind: 'VIDEO', playbackStatus: 'READY' }; }],
		['activeLegacyUploadSessions', (snapshot: ContractPreflightSnapshot) => { snapshot.uploadSessions.push({ id: 's1', status: 'COMPLETING', uploadKind: 'GAME', storageKey: null }); }],
		['legacyBridgeObservations', (snapshot: ContractPreflightSnapshot) => { snapshot.metrics.push({ name: 'asset_download_legacy_fallback', scope: 'original', value: 1n, lastObservedAt: now() }); }],
		['malformedWebglDeployments', (snapshot: ContractPreflightSnapshot) => { snapshot.projects.push({ id: 7, status: 'PUBLISHED', webglEntryKey: 'bad', currentWebglDeploymentId: null, currentWebglDeployment: null }); }],
	] as const)('reports %s', async (blocker, mutate) => {
		const snapshot = baseSnapshot();
		mutate(snapshot);
		const { report } = await audit(snapshot);
		expect(report.blockers[blocker].count).toBeGreaterThan(0);
		expect(report.clean).toBe(false);
	});

	it('blocks missing HEAD objects and turns Garage outage/timeout into operational failures', async () => {
		await expect(audit(baseSnapshot(), [{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' }], vi.fn(async () => null))).resolves.toMatchObject({ report: { blockers: { missingObjects: { count: 1 } } } });
		await expect(audit(baseSnapshot(), [{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' }], vi.fn(async () => { throw new Error('Garage down'); }))).rejects.toThrow('Garage HEAD operational failure');
		await expect(audit(baseSnapshot(), [{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' }], vi.fn(async () => new Promise<never>(() => undefined)), { headTimeoutMs: 100 })).rejects.toThrow('timed out');
	});

	it('blocks READY representation metadata/source-identity mismatches from Garage HEAD', async () => {
		const snapshot = baseSnapshot();
		const representation = snapshot.assets[0]!.representations[0]!;
		representation.etag = null;
		representation.sourceIdentityAlgorithm = 'MIGRATION_COPY_SHA256';
		representation.sourceIdentity = 'a'.repeat(64);
		const mismatched = await audit(snapshot, undefined, vi.fn(async () => ({
			sizeBytes: 1n, mimeType: 'application/octet-stream', etag: null,
			checksumSha256: 'b'.repeat(64),
		})));
		expect(mismatched.report.blockers.objectMetadataMismatches).toMatchObject({ count: 1 });
		expect(mismatched.report.blockers.objectMetadataMismatches.samples[0]).toContain('source-sha256');
		expect(mismatched.report.counts.verifiedCanonicalObjects).toBe(0);
		expect(mismatched.report.counts.unresolvedRows).toBe(1);
	});

	it('does not substitute a matching persisted ETag when HEAD cannot verify the expected SHA', async () => {
		const snapshot = baseSnapshot();
		const representation = snapshot.assets[0]!.representations[0]!;
		representation.etag = 'matching-etag';
		representation.checksumAlgorithm = 'SHA256';
		representation.checksum = 'a'.repeat(64);
		const result = await audit(snapshot, undefined, vi.fn(async () => ({
			sizeBytes: 1n, mimeType: 'application/octet-stream', etag: 'matching-etag', checksumSha256: null,
		})));
		expect(result.report.blockers.objectMetadataMismatches.samples[0]).toContain('sha256-unverifiable');
		expect(result.report.counts.verifiedCanonicalObjects).toBe(0);
	});

	it('does not substitute a matching persisted ETag for a SHA source identity', async () => {
		const snapshot = baseSnapshot();
		const representation = snapshot.assets[0]!.representations[0]!;
		representation.etag = 'matching-etag';
		representation.sourceIdentityAlgorithm = 'MIGRATION_COPY_SHA256';
		representation.sourceIdentity = 'a'.repeat(64);
		const result = await audit(snapshot, undefined, vi.fn(async () => ({
			sizeBytes: 1n, mimeType: 'application/octet-stream', etag: 'matching-etag', checksumSha256: null,
		})));
		expect(result.report.blockers.objectMetadataMismatches.samples[0]).toContain('source-sha256-unverifiable');
		expect(result.report.counts.verifiedCanonicalObjects).toBe(0);
	});

	it('validates every READY representation expectation when one asset reuses a physical object', async () => {
		const snapshot = baseSnapshot();
		snapshot.assets[0]!.representations.push({
			id: 'r2', assetId: 1, role: 'PLAYBACK', bucket: 'protected',
			objectKey: 'protected/assets/1/original/g1.zip', state: 'READY',
			...objectMetadata, etag: 'different-etag',
		});
		const result = await audit(snapshot);
		expect(result.report.blockers.objectMetadataMismatches.samples[0]).toContain('canonical-metadata-conflict');
		expect(result.report.counts.verifiedCanonicalObjects).toBe(0);
		expect(result.report.counts.unresolvedRows).toBe(1);
	});

	it('allows multiple roles for one asset but blocks the same physical object owned by another asset', async () => {
		const sameOwner = baseSnapshot();
		sameOwner.assets[0]!.representations.push({ id: 'r2', assetId: 1, role: 'PLAYBACK', bucket: 'protected', objectKey: 'protected/assets/1/original/g1.zip', state: 'READY', ...objectMetadata });
		expect((await audit(sameOwner)).report.blockers.duplicateCanonicalOwnership.count).toBe(0);
		const differentOwner = baseSnapshot();
		differentOwner.assets.push({ id: 2, projectId: 10, exhibitionId: null, kind: 'GAME', status: 'READY', storageKey: null, playbackStorageKey: null, playbackStatus: 'PENDING', card480Height: null, display960Height: null, representations: [{ id: 'r2', assetId: 2, role: 'ORIGINAL', bucket: 'protected', objectKey: 'protected/assets/1/original/g1.zip', state: 'READY', ...objectMetadata }] });
		expect((await audit(differentOwner)).report.blockers.duplicateCanonicalOwnership.count).toBe(1);
	});

	it('flags unknown inventory keys and requires an explicit confirmation to reset observations', async () => {
		const unknown = await audit(baseSnapshot(), [{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' }, { bucket: 'public', key: 'unowned' }]);
		expect(unknown.report.blockers.unknownInventoryOwnership.count).toBe(1);
		await expect(audit(baseSnapshot(), undefined, undefined, { resetObservation: true })).rejects.toThrow('requires --confirm-reset');
		const reset = await audit(baseSnapshot(), undefined, undefined, { resetObservation: true, resetConfirmation: CONTRACT_PREFLIGHT_RESET_CONFIRMATION });
		expect(reset.repository.resetLegacyBridgeObservations).toHaveBeenCalledOnce();
	});

	it('requires every WebGL manifest object to be HEAD-verified and never owns an unlisted prefix object', async () => {
		const snapshot = baseSnapshot();
		snapshot.assets.push({
			id: 2, projectId: 22, exhibitionId: null, kind: 'WEBGL', status: 'READY',
			storageKey: null, playbackStorageKey: null, playbackStatus: 'PENDING',
			card480Height: null, display960Height: null,
			representations: [{ id: 'webgl-source', assetId: 2, role: 'WEBGL_SOURCE', bucket: 'protected', objectKey: 'protected/uploads/source.zip', state: 'READY', ...objectMetadata }],
		});
		snapshot.projects.push({
			id: 22, status: 'PUBLISHED', webglEntryKey: '', currentWebglDeploymentId: 'deployment',
			currentWebglDeployment: {
				id: 'deployment', projectId: 22, sourceRepresentationId: 'webgl-source',
				publicBucket: 'public', publicPrefix: 'public/webgl/22/deployment/',
				entryObjectKey: 'public/webgl/22/deployment/index.html', state: 'READY',
				objectManifest: { version: 1, objects: [
					{ objectKey: 'public/webgl/22/deployment/index.html', sizeBytes: '10', mimeType: 'text/html', etag: 'i', checksumSha256: null },
					{ objectKey: 'public/webgl/22/deployment/Build/game.wasm', sizeBytes: '20', mimeType: 'application/wasm', etag: 'w', checksumSha256: null },
				] },
				stagingBucket: null, stagingPrefix: null,
				stagingEntryObjectKey: null, stagingObjectManifest: null,
			},
		});
		snapshot.deployments.push(snapshot.projects.at(-1)!.currentWebglDeployment!);
		const inventory = [
			{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' },
			{ bucket: 'protected', key: 'protected/uploads/source.zip' },
			{ bucket: 'public', key: 'public/webgl/22/deployment/index.html' },
			{ bucket: 'public', key: 'public/webgl/22/deployment/Build/game.wasm' },
		];
		const checked = headForSnapshot(snapshot);
		const clean = await audit(snapshot, inventory, checked);
		expect(clean.report.clean).toBe(true);
		expect(checked).toHaveBeenCalledTimes(4);

		const unknown = await audit(snapshot, [...inventory, {
			bucket: 'public', key: 'public/webgl/22/deployment/unlisted.data',
		}], checked);
		expect(unknown.report.blockers.unknownInventoryOwnership.count).toBe(1);

		const duplicateGeneration = structuredClone(snapshot);
		duplicateGeneration.deployments.push({
			...structuredClone(snapshot.deployments[0]!), id: 'duplicate-deployment',
		});
		const duplicated = await audit(duplicateGeneration, inventory, headForSnapshot(duplicateGeneration));
		expect(duplicated.report.blockers.duplicateCanonicalOwnership.count).toBe(2);

		const manifestMismatchHead = headForSnapshot(snapshot);
		const mismatched = await audit(snapshot, inventory, vi.fn(async (bucket, key, signal) => {
			const metadata = await manifestMismatchHead(bucket, key, signal);
			return key.endsWith('game.wasm') && metadata ? { ...metadata, sizeBytes: metadata.sizeBytes + 1n } : metadata;
		}));
		expect(mismatched.report.blockers.objectMetadataMismatches.samples).toContain(
			'public:public/webgl/22/deployment/Build/game.wasm:size:21->20',
		);
		expect(mismatched.report.counts.unresolvedRows).toBe(1);
	});

	it('validates WebGL source role/project ownership and exhibition poster pointer renditions', async () => {
		const snapshot = baseSnapshot();
		snapshot.assets.push({
			id: 7, projectId: null, exhibitionId: 7, kind: 'POSTER', status: 'READY',
			storageKey: null, playbackStorageKey: null, playbackStatus: 'PENDING',
			card480Height: 100, display960Height: null,
			representations: [
				{ id: 'poster-original', assetId: 7, role: 'ORIGINAL', bucket: 'public', objectKey: 'public/images/exhibitions/7/original/g.jpg', state: 'READY', ...objectMetadata },
				{ id: 'poster-card', assetId: 7, role: 'CARD_480', bucket: 'public', objectKey: 'public/images/exhibitions/7/card_480/g.webp', state: 'READY', ...objectMetadata },
				{ id: 'poster-display', assetId: 7, role: 'DISPLAY_960', bucket: 'public', objectKey: 'public/images/exhibitions/7/display_960/g.webp', state: 'READY', ...objectMetadata },
			],
		});
		snapshot.exhibitions.push({ id: 7, posterStorageKey: 'legacy-poster.jpg', posterAssetId: 7, posterCard480Height: 100, posterDisplay960Height: null });
		const result = await audit(snapshot, [
			{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' },
			{ bucket: 'public', key: 'public/images/exhibitions/7/original/g.jpg' },
			{ bucket: 'public', key: 'public/images/exhibitions/7/card_480/g.webp' },
			{ bucket: 'public', key: 'public/images/exhibitions/7/display_960/g.webp' },
		]);
		expect(result.report.clean).toBe(true);
		snapshot.assets[1]!.exhibitionId = 8;
		expect((await audit(snapshot)).report.blockers.unresolvedRepresentations.count).toBeGreaterThan(0);
	});

	it('tracks the explicit complete set of compatibility producers', async () => {
		for (const name of LEGACY_BRIDGE_METRIC_NAMES) {
			const snapshot = baseSnapshot();
			snapshot.metrics.push({ name, scope: 'test', value: 1n, lastObservedAt: now() });
			expect((await audit(snapshot)).report.blockers.legacyBridgeObservations.count).toBe(1);
		}
	});

	it('requires a complete 24-hour zero observation for every fallback producer', async () => {
		const missing = baseSnapshot();
		missing.metrics = missing.metrics.filter((metric) => metric.name !== LEGACY_BRIDGE_METRIC_NAMES[0]);
		expect((await audit(missing)).report.blockers.legacyBridgeObservations.samples).toContain(
			`metric:${LEGACY_BRIDGE_METRIC_NAMES[0]}:missing`,
		);
		const recent = baseSnapshot();
		recent.metrics[0]!.lastObservedAt = new Date('2026-08-20T12:00:00.000Z');
		expect((await audit(recent)).report.blockers.legacyBridgeObservations.samples[0]).toContain('observation-window');
	});

	it('waives only observation age and records the explicit exception without resetting metrics', async () => {
		const recent = baseSnapshot();
		recent.metrics[0]!.lastObservedAt = new Date('2026-08-20T12:00:00.000Z');
		const options = { observationExceptionId: 'reviewed-20260910', observationWindowMs: 0 };
		const result = await audit(recent, undefined, undefined, options);
		expect(result.report.clean).toBe(true);
		expect(result.report.observationExceptionId).toBe('reviewed-20260910');
		expect(result.report.metricObservationReset).toBe(false);
		expect(result.repository.resetLegacyBridgeObservations).not.toHaveBeenCalled();
		for (const metric of [
			{ value: 1n, lastObservedAt: now() },
			{ value: 0n, lastObservedAt: null },
			{ value: 0n, lastObservedAt: new Date(NaN) },
			{ value: 0n, lastObservedAt: new Date('2026-08-22T00:00:00Z') },
		]) {
			const invalid = baseSnapshot();
			Object.assign(invalid.metrics[0]!, metric);
			expect((await audit(invalid, undefined, undefined, options)).report.blockers.legacyBridgeObservations.count).toBeGreaterThan(0);
		}
		const missing = baseSnapshot();
		missing.metrics = [];
		expect((await audit(missing, undefined, undefined, options)).report.clean).toBe(false);
		const missingFile = await audit(recent, undefined, async () => null, options);
		expect(missingFile.report.blockers.missingObjects.count).toBeGreaterThan(0);
	});

	it('audits every READY historical WebGL generation, not only the current pointer', async () => {
		const snapshot = baseSnapshot();
		snapshot.assets.push({
			id: 2, projectId: 22, exhibitionId: null, kind: 'WEBGL', status: 'READY',
			storageKey: null, playbackStorageKey: null, playbackStatus: 'PENDING',
			card480Height: null, display960Height: null,
			representations: [{ id: 'webgl-source', assetId: 2, role: 'WEBGL_SOURCE', bucket: 'protected', objectKey: 'webgl/source.zip', state: 'READY', ...objectMetadata }],
		});
		const current = {
			id: 'current', projectId: 22, sourceRepresentationId: 'webgl-source', publicBucket: 'public',
			publicPrefix: 'webgl/22/current/', entryObjectKey: 'webgl/22/current/index.html', state: 'READY',
			objectManifest: { version: 1, objects: [{ objectKey: 'webgl/22/current/index.html', sizeBytes: '1', mimeType: 'text/html', etag: null, checksumSha256: null }] },
			stagingBucket: null, stagingPrefix: null,
			stagingEntryObjectKey: null, stagingObjectManifest: null,
		};
		snapshot.projects.push({ id: 22, status: 'PUBLISHED', webglEntryKey: '', currentWebglDeploymentId: current.id, currentWebglDeployment: current });
		snapshot.deployments.push(current, {
			...current, id: 'historical', publicPrefix: 'webgl/22/historical/',
			entryObjectKey: 'webgl/22/historical/index.html', objectManifest: { version: 1, objects: [] },
		});
		const result = await audit(snapshot, [
			{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' },
			{ bucket: 'protected', key: 'webgl/source.zip' },
			{ bucket: 'public', key: 'webgl/22/current/index.html' },
		]);
		expect(result.report.blockers.malformedWebglDeployments.samples).toContain('deployment:historical:invalid-object-manifest');
	});

	it('blocks wrong role buckets, active Garage multipart, and unresolved cleanup outbox rows', async () => {
		const snapshot = baseSnapshot();
		snapshot.assets[0]!.representations[0]!.bucket = 'public';
		snapshot.cleanupTasks.push({ kind: 'MULTIPART_ABORT', id: 'abort-1', state: 'PENDING' });
		const repository = { readSnapshot: vi.fn(async () => snapshot), resetLegacyBridgeObservations: vi.fn(async () => undefined) };
		const report = await runContractPreflight({
			repository,
			inventory: {
				identity: 'inventory-with-multipart', capturedAt: now().toISOString(),
				objects: [{ bucket: 'public', key: 'protected/assets/1/original/g1.zip' }],
				multipartUploads: [{ bucket: 'protected', key: 'protected/uploads/legacy', uploadId: 'garage-upload-1' }],
			},
			head: headForSnapshot(snapshot), now,
		});
		expect(report.blockers.bucketPolicyViolations.count).toBe(1);
		expect(report.blockers.activeGarageMultipartUploads.count).toBe(1);
		expect(report.blockers.pendingCleanupOutbox.count).toBe(1);
	});

	it.each([
		['public source', (asset: ContractPreflightSnapshot['assets'][number]) => { asset.representations[0]!.bucket = 'public'; }],
		['missing target', (asset: ContractPreflightSnapshot['assets'][number]) => { asset.representations[0]!.publicationBucket = null; asset.representations[0]!.publicationObjectKey = null; }],
		['wrong project scope', (asset: ContractPreflightSnapshot['assets'][number]) => { asset.representations[0]!.objectKey = asset.representations[0]!.objectKey.replace('/projects/30/', '/projects/99/'); }],
		['non-UUID scope', (asset: ContractPreflightSnapshot['assets'][number]) => { asset.representations[0]!.objectKey = asset.representations[0]!.objectKey.replace('11111111-1111-4111-8111-111111111111', 'not-a-uuid'); }],
		['missing provenance', (asset: ContractPreflightSnapshot['assets'][number]) => { asset.representations[0]!.sourceIdentity = null; }],
	] as const)('blocks DRAFT publication state with %s', async (_label, mutate) => {
		const snapshot = baseSnapshot();
		const asset = addImageProject(snapshot, 'DRAFT');
		mutate(asset);
		const inventory = snapshot.assets.flatMap((candidate) => candidate.representations.map((representation) => ({
			bucket: representation.bucket, key: representation.objectKey,
		})));
		const report = (await audit(snapshot, inventory)).report;
		expect(report.blockers.bucketPolicyViolations.count).toBeGreaterThan(0);
		expect(report.clean).toBe(false);
	});

	it('verifies COMMITTED relocation sources without counting them as final canonical objects', async () => {
		const snapshot = baseSnapshot();
		const asset = addImageProject(snapshot, 'PUBLISHED');
		const destination = asset.representations[0]!;
		snapshot.relocations.push({
			id: 'relocation-original', workKind: 'asset', workRef: String(asset.id), role: 'ORIGINAL',
			sourceBucket: 'public', sourceObjectKey: 'legacy/original.webp',
			destinationBucket: destination.bucket, destinationObjectKey: destination.objectKey,
			sizeBytes: 1n, mimeType: 'image/webp', checksumSha256: 'a'.repeat(64), state: 'COMMITTED',
		});
		const inventory = [
			...snapshot.assets.flatMap((candidate) => candidate.representations.map((representation) => ({ bucket: representation.bucket, key: representation.objectKey }))),
			{ bucket: 'public', key: 'legacy/original.webp' },
		];
		const metadataHead = vi.fn(async (bucket: string, key: string, signal: AbortSignal) => {
			if (bucket === 'public' && key === 'legacy/original.webp') return {
				sizeBytes: 1n, mimeType: 'image/webp', etag: null, checksumSha256: 'a'.repeat(64),
			};
			return headForSnapshot(snapshot)(bucket, key, signal);
		});
		const report = (await audit(snapshot, inventory, metadataHead)).report;
		expect(report.clean).toBe(true);
		expect(report.counts.verifiedCanonicalObjects).toBe(4);
		expect(report.counts.verifiedRelocationSources).toBe(1);
		expect(report.counts.physicalCopies).toBe(0);

		snapshot.relocations[0]!.state = 'MATERIALIZED';
		expect((await audit(snapshot, inventory, metadataHead)).report.blockers.incompleteObjectRelocations.count).toBe(1);
	});
});

describe('pinned image bridge evidence', () => {
 const options = { observationExceptionId: 'reviewed-bridge36', observationWindowMs: 0, exceptionProfile: 'image-bridge-36' as const };
 async function run(override = {}, other = false) {
  const snapshot = baseSnapshot();
  snapshot.metrics.push({ name: 'public_image_legacy_bridge', scope: 'api-route', value: 36n, lastObservedAt: new Date('2026-09-09T10:37:52.913Z'), details: { usedLegacyLookup: false }, ...override });
  if (other) snapshot.metrics.push({ name: 'unknown-producer', scope: '', value: 1n, lastObservedAt: new Date('2026-09-09T12:00:00Z') });
  return runContractPreflight({ repository: { readSnapshot: async () => snapshot, resetLegacyBridgeObservations: async () => { throw new Error('must never reset'); } }, inventory: { identity: 'fixture', capturedAt: '2026-09-10T00:00:00Z', objects: [{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' }], multipartUploads: [] }, head: headForSnapshot(snapshot), options, now: () => new Date('2026-09-10T00:00:00Z') });
 }
 it('retains the true count and profile while accepting exact evidence', async () => {
  expect(await run()).toMatchObject({ clean: true, counts: { legacyFallbackReads: 36 }, exceptionProfile: 'image-bridge-36', metricObservationReset: false });
 });
 it.each([{ value: 35n }, { value: 37n }, { value: 0n }, { scope: 'other' }, { lastObservedAt: new Date('2026-09-09T10:37:52.914Z') }, { details: { usedLegacyLookup: true } }, { details: { usedLegacyLookup: 'false' } }, { details: null }])('rejects pinned evidence drift %#', async (override) => {
  expect((await run(override)).clean).toBe(false);
 });
 it('rejects unrelated nonzero producers just as SQL does', async () => { expect((await run({}, true)).clean).toBe(false); });
});

it('rejects a bridge profile with reset before any repository mutation', async () => {
 const repository = { readSnapshot: vi.fn(async () => baseSnapshot()), resetLegacyBridgeObservations: vi.fn(async () => undefined) };
 await expect(runContractPreflight({ repository, inventory: { identity: 'fixture', capturedAt: now().toISOString(), objects: [], multipartUploads: [] }, head: vi.fn(), options: { observationExceptionId: 'reviewed-bridge36', exceptionProfile: 'image-bridge-36', observationWindowMs: 0, resetObservation: true, resetConfirmation: CONTRACT_PREFLIGHT_RESET_CONFIRMATION } })).rejects.toThrow('without metric reset');
 expect(repository.resetLegacyBridgeObservations).not.toHaveBeenCalled();
 expect(repository.readSnapshot).not.toHaveBeenCalled();
});


describe('canonical image bridge traffic classification', () => {
	async function run(override = {}, extraMetric = false) {
		const snapshot = baseSnapshot();
		snapshot.metrics.push({ name: 'public_image_legacy_bridge', scope: 'api-route', value: 37n, lastObservedAt: now(), details: { usedLegacyLookup: false }, ...override });
		if (extraMetric) snapshot.metrics.push({ name: 'public_image_legacy_fallback', scope: 'actual-fallback', value: 1n, lastObservedAt: now() });
		return audit(snapshot, undefined, undefined, { observationExceptionId: 'traffic-20260910', observationWindowMs: 0, exceptionProfile: 'image-bridge-traffic' });
	}
	it.each([0n, 1n, 37n, 1000n, BigInt(Number.MAX_SAFE_INTEGER)])('accepts count %s without rewriting the measured count', async (value) => {
		const { report, repository } = await run({ value });
		expect(report).toMatchObject({ clean: true, counts: { legacyFallbackReads: Number(value) }, exceptionProfile: 'image-bridge-traffic' });
		expect(repository.resetLegacyBridgeObservations).not.toHaveBeenCalled();
	});
	it.each([{ value: -1n }, { value: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, { scope: 'other' }, { details: { usedLegacyLookup: true } }, { details: { usedLegacyLookup: 'false' } }, { details: null }, { lastObservedAt: null }, { lastObservedAt: new Date('invalid') }, { lastObservedAt: new Date('2027-01-01T00:00:00Z') }])('rejects unsafe signal %#', async (override) => {
		expect((await run(override)).report.clean).toBe(false);
	});
	it('still rejects actual fallback when the last bridge lookup was canonical', async () => {
		expect((await run({}, true)).report.clean).toBe(false);
	});
	it('rejects missing observations and authorizations', async () => {
		const missing = baseSnapshot();
		missing.metrics = [];
		expect((await audit(missing, undefined, undefined, { observationExceptionId: 'traffic-20260910', observationWindowMs: 0, exceptionProfile: 'image-bridge-traffic' })).report.clean).toBe(false);
		await expect(audit(baseSnapshot(), undefined, undefined, { observationWindowMs: 0, exceptionProfile: 'image-bridge-traffic' })).rejects.toThrow();
	});
});
