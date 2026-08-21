import { describe, expect, it, vi } from 'vitest';
import {
	CONTRACT_PREFLIGHT_RESET_CONFIRMATION,
	LEGACY_BRIDGE_METRIC_NAMES,
	runContractPreflight,
	type ContractPreflightSnapshot,
} from '../modules/migration/contract-preflight.js';

const now = () => new Date('2026-08-21T00:00:00.000Z');
const baseSnapshot = (): ContractPreflightSnapshot => ({
	assets: [{
		id: 1, projectId: 10, exhibitionId: null,
		kind: 'GAME', status: 'READY', storageKey: 'protected/assets/1/original/g1.zip',
		playbackStorageKey: null, playbackStatus: 'PENDING',
		card480Height: null, display960Height: null,
		representations: [{ id: 'r1', assetId: 1, role: 'ORIGINAL', bucket: 'protected', objectKey: 'protected/assets/1/original/g1.zip', state: 'READY' }],
	}],
	exhibitions: [], projects: [], metrics: [], uploadSessions: [],
});

async function audit(snapshot = baseSnapshot(), inventory = [{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' }], head = vi.fn(async () => true), options = {}) {
	const repository = { readSnapshot: vi.fn(async () => snapshot), resetLegacyBridgeObservations: vi.fn(async () => undefined) };
	const report = await runContractPreflight({ repository, inventory: { identity: 'fixture-inventory', capturedAt: now().toISOString(), objects: inventory }, head, now, options });
	return { report, repository, head };
}

describe('canonical contract preflight', () => {
	it('is clean for a fully owned ready representation and excludes terminal assets', async () => {
		const snapshot = baseSnapshot();
		snapshot.assets.push({ id: 2, projectId: 10, exhibitionId: null, kind: 'IMAGE', status: 'DELETED', storageKey: 'deleted', playbackStorageKey: null, playbackStatus: 'PENDING', card480Height: null, display960Height: null, representations: [] });
		const { report } = await audit(snapshot);
		expect(report.clean).toBe(true);
		expect(report.counts).toMatchObject({ legacyRows: 1, backfilledRows: 1, migratedObjects: 1, terminalAssetsExcluded: 1 });
	});

	it.each([
		['legacyOnlyActiveAssets', (snapshot: ContractPreflightSnapshot) => { snapshot.assets[0]!.representations = []; }],
		['unresolvedRepresentations', (snapshot: ContractPreflightSnapshot) => { snapshot.assets[0]!.representations[0]!.state = 'FAILED'; }],
		['playbackOrphans', (snapshot: ContractPreflightSnapshot) => { snapshot.assets[0] = { ...snapshot.assets[0]!, kind: 'VIDEO', playbackStatus: 'READY' }; }],
		['activeLegacyUploadSessions', (snapshot: ContractPreflightSnapshot) => { snapshot.uploadSessions.push({ id: 's1', status: 'COMPLETING', uploadKind: 'GAME', storageKey: null }); }],
		['legacyBridgeObservations', (snapshot: ContractPreflightSnapshot) => { snapshot.metrics.push({ name: 'asset_download_legacy_fallback', scope: 'original', value: 1n, lastObservedAt: now() }); }],
		['malformedWebglDeployments', (snapshot: ContractPreflightSnapshot) => { snapshot.projects.push({ id: 7, webglEntryKey: 'bad', currentWebglDeploymentId: null, currentWebglDeployment: null }); }],
	] as const)('reports %s', async (blocker, mutate) => {
		const snapshot = baseSnapshot();
		mutate(snapshot);
		const { report } = await audit(snapshot);
		expect(report.blockers[blocker].count).toBeGreaterThan(0);
		expect(report.clean).toBe(false);
	});

	it('blocks missing HEAD objects and turns Garage outage/timeout into operational failures', async () => {
		await expect(audit(baseSnapshot(), [{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' }], vi.fn(async () => false))).resolves.toMatchObject({ report: { blockers: { missingObjects: { count: 1 } } } });
		await expect(audit(baseSnapshot(), [{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' }], vi.fn(async () => { throw new Error('Garage down'); }))).rejects.toThrow('Garage HEAD operational failure');
		await expect(audit(baseSnapshot(), [{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' }], vi.fn(async () => new Promise<boolean>(() => undefined)), { headTimeoutMs: 100 })).rejects.toThrow('timed out');
	});

	it('allows multiple roles for one asset but blocks the same physical object owned by another asset', async () => {
		const sameOwner = baseSnapshot();
		sameOwner.assets[0]!.representations.push({ id: 'r2', assetId: 1, role: 'PLAYBACK', bucket: 'protected', objectKey: 'protected/assets/1/original/g1.zip', state: 'READY' });
		expect((await audit(sameOwner)).report.blockers.duplicateCanonicalOwnership.count).toBe(0);
		const differentOwner = baseSnapshot();
		differentOwner.assets.push({ id: 2, projectId: 10, exhibitionId: null, kind: 'GAME', status: 'READY', storageKey: null, playbackStorageKey: null, playbackStatus: 'PENDING', card480Height: null, display960Height: null, representations: [{ id: 'r2', assetId: 2, role: 'ORIGINAL', bucket: 'protected', objectKey: 'protected/assets/1/original/g1.zip', state: 'READY' }] });
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
			representations: [{ id: 'webgl-source', assetId: 2, role: 'WEBGL_SOURCE', bucket: 'protected', objectKey: 'protected/uploads/source.zip', state: 'READY' }],
		});
		snapshot.projects.push({
			id: 22, webglEntryKey: '', currentWebglDeploymentId: 'deployment',
			currentWebglDeployment: {
				id: 'deployment', projectId: 22, sourceRepresentationId: 'webgl-source',
				publicBucket: 'public', publicPrefix: 'public/webgl/22/deployment/',
				entryObjectKey: 'public/webgl/22/deployment/index.html', state: 'READY',
				objectManifest: { version: 1, objects: [
					{ objectKey: 'public/webgl/22/deployment/index.html', sizeBytes: '10', mimeType: 'text/html', etag: 'i', checksumSha256: null },
					{ objectKey: 'public/webgl/22/deployment/Build/game.wasm', sizeBytes: '20', mimeType: 'application/wasm', etag: 'w', checksumSha256: null },
				] },
			},
		});
		const inventory = [
			{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' },
			{ bucket: 'protected', key: 'protected/uploads/source.zip' },
			{ bucket: 'public', key: 'public/webgl/22/deployment/index.html' },
			{ bucket: 'public', key: 'public/webgl/22/deployment/Build/game.wasm' },
		];
		const checked = vi.fn(async () => true);
		const clean = await audit(snapshot, inventory, checked);
		expect(clean.report.clean).toBe(true);
		expect(checked).toHaveBeenCalledTimes(4);

		const unknown = await audit(snapshot, [...inventory, {
			bucket: 'public', key: 'public/webgl/22/deployment/unlisted.data',
		}], checked);
		expect(unknown.report.blockers.unknownInventoryOwnership.count).toBe(1);
	});

	it('validates WebGL source role/project ownership and exhibition poster pointer renditions', async () => {
		const snapshot = baseSnapshot();
		snapshot.assets.push({
			id: 7, projectId: null, exhibitionId: 7, kind: 'POSTER', status: 'READY',
			storageKey: null, playbackStorageKey: null, playbackStatus: 'PENDING',
			card480Height: 100, display960Height: null,
			representations: [
				{ id: 'poster-original', assetId: 7, role: 'ORIGINAL', bucket: 'public', objectKey: 'poster.jpg', state: 'READY' },
				{ id: 'poster-card', assetId: 7, role: 'CARD_480', bucket: 'public', objectKey: 'poster-card.webp', state: 'READY' },
			],
		});
		snapshot.exhibitions.push({ id: 7, posterStorageKey: 'legacy-poster.jpg', posterAssetId: 7, posterCard480Height: 100, posterDisplay960Height: null });
		const result = await audit(snapshot, [
			{ bucket: 'protected', key: 'protected/assets/1/original/g1.zip' },
			{ bucket: 'public', key: 'poster.jpg' },
			{ bucket: 'public', key: 'poster-card.webp' },
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
});
