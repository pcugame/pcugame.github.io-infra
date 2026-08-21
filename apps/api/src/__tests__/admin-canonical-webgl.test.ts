import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { createProjectCrudRepository } from '../modules/admin/project/crud.repository.js';
import { projectWebglDeletionTargets } from '../modules/admin/project/project-deletion-targets.js';

const deploymentId = '123e4567-e89b-42d3-a456-426614174000';
const prefix = `public/webgl/7/${deploymentId}/`;
const entry = `${prefix}index.html`;
const source = `protected/uploads/webgl/${deploymentId}/source.zip`;
const snapshot = {
	id: deploymentId,
	projectId: 7,
	publicBucket: 'public',
	publicPrefix: prefix,
	entryObjectKey: entry,
	objectManifest: {
		version: 1,
		objects: [
			{ objectKey: entry, sizeBytes: '10', mimeType: 'text/html' },
			{ objectKey: `${prefix}Build/game.wasm.br`, sizeBytes: '20', mimeType: 'application/wasm' },
		],
	},
	sourceRepresentation: {
		id: 'webgl-source', assetId: 11, role: 'WEBGL_SOURCE', bucket: 'protected', objectKey: source,
	},
};
const outbox = { publicBucket: 'public', protectedBucket: 'protected', reason: 'webgl-delete' };

describe('canonical admin WebGL integration', () => {
	it('deletes exact manifest keys and never guesses a prefix when a manifest exists', () => {
		const targets = projectWebglDeletionTargets(7, entry, outbox, [snapshot]);
		expect(targets.map(({ bucket, storageKey, targetKind }) => ({ bucket, storageKey, targetKind }))).toEqual([
			{ bucket: 'protected', storageKey: source, targetKind: undefined },
			{ bucket: 'public', storageKey: entry, targetKind: 'EXACT' },
			{ bucket: 'public', storageKey: `${prefix}Build/game.wasm.br`, targetKind: 'EXACT' },
		]);
		expect(targets.some(({ targetKind }) => targetKind === 'PREFIX')).toBe(false);
	});

	it('fails closed on a malformed manifest instead of falling back to prefix deletion', () => {
		expect(() => projectWebglDeletionTargets(7, entry, outbox, [{
			...snapshot,
			objectManifest: { version: 1, objects: [{ objectKey: '../outside' }] },
		}])).toThrow(/manifest escapes/);
	});

	it('persists exact outbox targets and clears/deletes the fenced canonical deployment', async () => {
		const upsert = vi.fn(async ({ create }: { create: { storageKey: string } }) => ({ id: create.storageKey }));
		const deleteDeployments = vi.fn(async () => ({ count: 1 }));
		const tx = {
			project: {
				findUniqueOrThrow: vi.fn(async () => ({
					webglEntryKey: entry,
					currentWebglDeploymentId: deploymentId,
					webglDeployments: [snapshot],
				})),
				updateMany: vi.fn(async () => ({ count: 1 })),
			},
			gameUploadActiveSession: { findUnique: vi.fn(async () => null) },
			assetUploadSession: { findMany: vi.fn(async () => []), updateMany: vi.fn() },
			orphanObject: { upsert },
			$queryRaw: vi.fn(async () => []),
			webglDeployment: { deleteMany: deleteDeployments },
			assetRepresentation: { deleteMany: vi.fn(async () => ({ count: 1 })) },
			asset: { deleteMany: vi.fn(async () => ({ count: 1 })) },
		};
		const repository = createProjectCrudRepository({
			$transaction: vi.fn(async (work) => work(tx)),
		} as unknown as PrismaClient);

		await repository.clearWebglDeployment(7, outbox);

		expect(upsert.mock.calls.map(([input]) => input.create.storageKey)).toEqual([
			source, entry, `${prefix}Build/game.wasm.br`,
		]);
		expect(tx.project.updateMany).toHaveBeenCalledWith({
			where: { id: 7, currentWebglDeploymentId: deploymentId },
			data: { currentWebglDeploymentId: null, webglEntryKey: '' },
		});
		expect(deleteDeployments).toHaveBeenCalledWith({ where: { projectId: 7 } });
	});

	it('aborts before deleting deployment rows when the current pointer CAS loses', async () => {
		const deleteDeployments = vi.fn();
		const tx = {
			project: {
				findUniqueOrThrow: vi.fn(async () => ({
					webglEntryKey: '', currentWebglDeploymentId: deploymentId, webglDeployments: [],
				})),
				updateMany: vi.fn(async () => ({ count: 0 })),
			},
			gameUploadActiveSession: { findUnique: vi.fn(async () => null) },
			assetUploadSession: { findMany: vi.fn(async () => []) },
			webglDeployment: { deleteMany: deleteDeployments },
		};
		const repository = createProjectCrudRepository({
			$transaction: vi.fn(async (work) => work(tx)),
		} as unknown as PrismaClient);

		await expect(repository.clearWebglDeployment(7, outbox)).rejects.toThrow(
			'WebGL deployment changed concurrently',
		);
		expect(deleteDeployments).not.toHaveBeenCalled();
	});

	it('records the explicit Phase 1 fallback metric for a legacy admin response', async () => {
		const upsert = vi.fn(async () => ({}));
		const repository = createProjectCrudRepository({
			project: { findUnique: vi.fn(async () => ({
				id: 7,
				webglEntryKey: `webgl/7/${deploymentId}/site/index.html`,
				currentWebglDeploymentId: null,
			})) },
			migrationMetric: { upsert },
		} as unknown as PrismaClient);

		await repository.findProjectById(7);
		expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
			where: { name_scope: { name: 'public_webgl_legacy_fallback', scope: 'admin-project-response' } },
		}));
	});
});
