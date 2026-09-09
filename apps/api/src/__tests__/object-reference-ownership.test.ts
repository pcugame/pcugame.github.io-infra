import { describe, expect, it, vi } from 'vitest';
import {
	collectObjectReferences,
	createObjectReferenceIndex,
} from '../modules/orphan/reference-resolver.js';

function emptyDelegate() {
	return { findMany: vi.fn(async () => []) };
}

const buckets = { publicBucket: 'public', protectedBucket: 'protected' };
const logger = { error: vi.fn() };

describe('object reference lifecycle ownership', () => {
	it('treats only allocating through verifying upload sessions as live', async () => {
		const rows = [
			'ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING',
			'READY', 'REJECTED', 'CANCELLED', 'EXPIRED',
		].map((state) => ({
			id: state.toLowerCase(),
			state,
			bucket: 'protected',
			objectKey: `uploads/${state.toLowerCase()}/source.zip`,
		}));
		const findMany = vi.fn(async (query: {
			where: { state: { in: string[] } };
		}) => rows.filter((row) => query.where.state.in.includes(row.state)));
		const inventory = await collectObjectReferences({
			asset: emptyDelegate(),
			project: emptyDelegate(),
			assetUploadSession: { findMany },
			uploadIntent: emptyDelegate(),
		} as never, buckets, logger);

		expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
			where: { state: { in: ['ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING'] } },
		}));
		expect(inventory.references.map(({ source }) => source)).toEqual([
			'upload-session:allocating:active',
			'upload-session:uploading:active',
			'upload-session:completing:active',
			'upload-session:verifying:active',
		]);
		const index = createObjectReferenceIndex(inventory);
		for (const state of ['ALLOCATING', 'UPLOADING', 'COMPLETING', 'VERIFYING']) {
			expect(index.referencesTarget({
				bucket: 'protected', targetKind: 'EXACT',
				key: `uploads/${state.toLowerCase()}/source.zip`,
			}), state).toBe(true);
		}
		for (const state of ['READY', 'REJECTED', 'CANCELLED', 'EXPIRED']) {
			expect(index.referencesTarget({
				bucket: 'protected', targetKind: 'EXACT',
				key: `uploads/${state.toLowerCase()}/source.zip`,
			}), state).toBe(false);
		}
	});

	it('blocks canonical representations, the current deployment, and uncommitted intents only', async () => {
		const deploymentId = '11111111-1111-4111-8111-111111111111';
		const intentRows = ['PREPARED', 'UPLOADED', 'COMMITTED', 'CLEANUP_QUEUED', 'RESOLVED']
			.map((state) => ({
				id: state.toLowerCase(), state, bucket: 'public',
				storageKey: `intent/${state.toLowerCase()}.webp`,
			}));
		const findIntents = vi.fn(async (query: {
			where: { state: { in: string[] } };
		}) => intentRows.filter((row) => query.where.state.in.includes(row.state)));
		const inventory = await collectObjectReferences({
			asset: { findMany: vi.fn(async () => [{
				id: 41,
				representations: [{
					id: 'source-representation', role: 'WEBGL_SOURCE',
					bucket: 'protected', objectKey: 'webgl/source.zip',
				}],
			}]) },
			project: { findMany: vi.fn(async () => [{
				id: 7,
				currentWebglDeploymentId: deploymentId,
				currentWebglDeployment: {
					id: deploymentId,
					state: 'READY',
					publicBucket: 'public',
					publicPrefix: `webgl/7/${deploymentId}/`,
					entryObjectKey: `webgl/7/${deploymentId}/index.html`,
					sourceRepresentation: {
						role: 'WEBGL_SOURCE', state: 'READY', bucket: 'protected', objectKey: 'webgl/source.zip',
					},
				},
			}]) },
			assetUploadSession: emptyDelegate(),
			uploadIntent: { findMany: findIntents },
		} as never, buckets, logger);

		expect(findIntents).toHaveBeenCalledWith(expect.objectContaining({
			where: { state: { in: ['PREPARED', 'UPLOADED'] } },
		}));
		const index = createObjectReferenceIndex(inventory);
		expect(index.referencesTarget({
			bucket: 'protected', targetKind: 'EXACT', key: 'webgl/source.zip',
		})).toBe(true);
		expect(index.referencesTarget({
			bucket: 'public', targetKind: 'EXACT',
			key: `webgl/7/${deploymentId}/Build/game.wasm`,
		})).toBe(true);
		for (const state of ['PREPARED', 'UPLOADED']) {
			expect(index.referencesTarget({
				bucket: 'public', targetKind: 'EXACT',
				key: `intent/${state.toLowerCase()}.webp`,
			}), state).toBe(true);
		}
		for (const state of ['COMMITTED', 'CLEANUP_QUEUED', 'RESOLVED']) {
			expect(index.referencesTarget({
				bucket: 'public', targetKind: 'EXACT',
				key: `intent/${state.toLowerCase()}.webp`,
			}), state).toBe(false);
		}
	});
});
