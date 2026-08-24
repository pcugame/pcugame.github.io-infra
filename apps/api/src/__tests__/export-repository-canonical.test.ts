import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
	createExportRepository,
	ExportSnapshotInvariantError,
} from '../modules/admin/export/repository.js';
import type { ClaimedExportJob, ExportSnapshot } from '../modules/admin/export/ports.js';

const updatedAt = new Date('2026-08-21T00:00:00.000Z');

function representation(id: string, assetId: number, role: string, objectKey: string) {
	return {
		id,
		assetId,
		role,
		bucket: role === 'CARD_480' || role === 'DISPLAY_960' ? 'public' : 'protected',
		objectKey,
		mimeType: role === 'ORIGINAL' ? 'application/octet-stream' : 'image/webp',
		sizeBytes: 100n,
		etag: `etag-${id}`,
		updatedAt,
		state: 'READY',
	};
}

function claim(overrides: Partial<ClaimedExportJob> = {}): ClaimedExportJob {
	return {
		id: 'export-1',
		year: 2026,
		dryRun: false,
		claimToken: 'claim-1',
		attemptCount: 1,
		maxAttempts: 3,
		createdAt: updatedAt.toISOString(),
		snapshot: null,
		snapshotHash: null,
		...overrides,
	};
}

describe('Phase 2 canonical export repository', () => {
	it('snapshots only canonical representations and the current WebGL source deployment', async () => {
		const gameOriginal = representation('game-original', 10, 'ORIGINAL', 'protected/assets/10/original/g1.zip');
		const videoOriginal = representation('video-original', 11, 'ORIGINAL', 'protected/assets/11/original/g1.mov');
		const imageOriginal = representation('image-original', 12, 'ORIGINAL', 'public/images/12/original/g1.webp');
		const imageCard = representation('image-card', 12, 'CARD_480', 'public/images/12/card-480/g1.webp');
		const webglSource = {
			...representation('webgl-source', 13, 'WEBGL_SOURCE', 'protected/assets/13/original/g1.zip'),
			asset: { originalName: 'webgl.zip' },
		};
		const client = {
			project: { findMany: vi.fn(async () => [{
				id: 7,
				title: 'Canonical project',
				exhibition: { year: 2026, title: 'Show' },
				members: [],
				currentWebglDeploymentId: 'deployment-1',
				currentWebglDeployment: {
					id: 'deployment-1',
					state: 'READY',
					sourceRepresentation: webglSource,
				},
				assets: [
					{ id: 10, kind: 'GAME', originalName: 'game.zip', representations: [gameOriginal] },
					{ id: 11, kind: 'VIDEO', originalName: 'video.mov', representations: [videoOriginal] },
					{ id: 12, kind: 'IMAGE', originalName: 'image.webp', representations: [imageOriginal, imageCard] },
				],
			}]) },
			$executeRaw: vi.fn(async () => 1),
		} as unknown as PrismaClient;
		const result = await createExportRepository(client).loadOrCreateSnapshot(claim());

		expect(result.snapshot.projects[0]?.objects.map(({ id, source }) => ({ id, source }))).toEqual([
			{ id: 'game-original', source: 'canonical' },
			{ id: 'video-original', source: 'canonical' },
			{ id: 'image-original', source: 'canonical' },
			{ id: 'image-card', source: 'canonical' },
			{ id: 'webgl-source', source: 'canonical' },
		]);
		expect(client.project.findMany).toHaveBeenCalledOnce();
	});

	it('rejects a persisted Phase 1 snapshot containing a legacy object', async () => {
		const legacySnapshot = {
			version: 1,
			jobId: 'export-1',
			year: 2026,
			createdAt: updatedAt.toISOString(),
			projects: [{
				id: 7,
				title: 'Legacy',
				exhibition: { year: 2026, title: 'Show' },
				currentWebglDeploymentId: null,
				members: [],
				objects: [{ source: 'legacy' }],
			}],
		} as unknown as ExportSnapshot;
		const repository = createExportRepository({} as PrismaClient);
		await expect(repository.loadOrCreateSnapshot(claim({
			snapshot: legacySnapshot,
			snapshotHash: 'old-hash',
		}))).rejects.toBeInstanceOf(ExportSnapshotInvariantError);
	});
});
