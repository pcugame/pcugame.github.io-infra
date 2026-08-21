import { describe, expect, it, vi } from 'vitest';
import { createCanonicalAsset } from '../modules/assets/representation-write.js';
import { projectAssetDeletionTargets } from '../modules/admin/project/project-deletion-targets.js';

function transactionHarness() {
	const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
		id: 41,
		...data,
		representations: (data.representations as { create: unknown[] }).create,
	}));
	return {
		create,
		tx: { asset: { create } } as never,
	};
}

describe('Phase-1 canonical asset writes', () => {
	it('persists video original and generated playback only as representation rows', async () => {
		const harness = transactionHarness();
		await createCanonicalAsset(harness.tx, {
			projectId: 7,
			kind: 'VIDEO',
			originalBucket: 'protected-source',
			storageKey: 'legacy-input/video.mov',
			playbackBucket: 'protected-playback',
			playbackStorageKey: 'generated/video.mp4',
			originalName: 'video.mov',
			mimeType: 'video/quicktime',
			playbackMimeType: 'video/mp4',
			sizeBytes: 1_000n,
			playbackSizeBytes: 600n,
			playbackStatus: 'READY',
			isPublic: false,
		});

		const data = harness.create.mock.calls[0]![0].data as {
			storageKey: null;
			playbackStorageKey: null;
			playbackStatus: string;
			representations: { create: Array<Record<string, unknown>> };
		};
		expect(data).toMatchObject({
			storageKey: null,
			playbackStorageKey: null,
			playbackStatus: 'PENDING',
		});
		expect(data.representations.create).toEqual([
			expect.objectContaining({ role: 'ORIGINAL', bucket: 'protected-source', objectKey: 'legacy-input/video.mov', state: 'READY' }),
			expect.objectContaining({ role: 'PLAYBACK', bucket: 'protected-playback', objectKey: 'generated/video.mp4', state: 'READY' }),
		]);
	});

	it('allows ORIGINAL and PLAYBACK roles to share one physical object', async () => {
		const harness = transactionHarness();
		await createCanonicalAsset(harness.tx, {
			projectId: 7, kind: 'VIDEO', originalBucket: 'protected', storageKey: 'video/browser-safe.mp4',
			playbackBucket: 'protected', originalName: 'video.mp4', mimeType: 'video/mp4',
			sizeBytes: 1_000n, playbackStatus: 'READY', isPublic: false,
		});
		const data = harness.create.mock.calls[0]![0].data as {
			representations: { create: Array<Record<string, unknown>> };
		};
		expect(data.representations.create).toEqual([
			expect.objectContaining({ role: 'ORIGINAL', bucket: 'protected', objectKey: 'video/browser-safe.mp4', sizeBytes: 1_000n }),
			expect.objectContaining({ role: 'PLAYBACK', bucket: 'protected', objectKey: 'video/browser-safe.mp4', sizeBytes: 1_000n }),
		]);
	});

	it('persists image renditions canonically while legacy readiness stays empty', async () => {
		const harness = transactionHarness();
		await createCanonicalAsset(harness.tx, {
			exhibitionId: 3,
			kind: 'POSTER',
			bucket: 'public',
			storageKey: 'posters/source.webp',
			originalName: 'poster.webp',
			mimeType: 'image/webp',
			sizeBytes: 900n,
			width: 1_200,
			height: 600,
			renditions: [
				{ profile: 'CARD_480', width: 480, height: 240 },
				{ profile: 'DISPLAY_960', width: 960, height: 480 },
			],
			isPublic: true,
		});

		const data = harness.create.mock.calls[0]![0].data as {
			card480Height: null;
			display960Height: null;
			representations: { create: Array<Record<string, unknown>> };
		};
		expect(data.card480Height).toBeNull();
		expect(data.display960Height).toBeNull();
		expect(data.representations.create.map(({ role }) => role)).toEqual([
			'ORIGINAL',
			'CARD_480',
			'DISPLAY_960',
		]);
	});

	it('rejects missing or ambiguous domain ownership', async () => {
		const harness = transactionHarness();
		const object = {
			kind: 'GAME' as const,
			bucket: 'protected',
			storageKey: 'game.zip',
			originalName: 'game.zip',
			mimeType: 'application/zip',
			sizeBytes: 100n,
			isPublic: false,
		};
		await expect(createCanonicalAsset(harness.tx, object)).rejects.toThrow('exactly one domain owner');
		await expect(createCanonicalAsset(harness.tx, {
			...object,
			projectId: 1,
			exhibitionId: 2,
		})).rejects.toThrow('exactly one domain owner');
		expect(harness.create).not.toHaveBeenCalled();
	});

	it('deletes canonical and legacy physical snapshots once per bucket/key', () => {
		expect(projectAssetDeletionTargets([{
			kind: 'VIDEO',
			storageKey: 'legacy-original.mov',
			playbackStorageKey: 'shared-playback.mp4',
			representations: [{
				role: 'ORIGINAL',
				bucket: 'protected-v2',
				objectKey: 'assets/41/original/g1',
			}, {
				role: 'PLAYBACK',
				bucket: 'protected-v2',
				objectKey: 'shared-playback.mp4',
			}],
		}], {
			publicBucket: 'legacy-public',
			protectedBucket: 'legacy-protected',
			reason: 'asset-delete',
		})).toEqual([
			expect.objectContaining({ bucket: 'protected-v2', storageKey: 'assets/41/original/g1' }),
			expect.objectContaining({ bucket: 'protected-v2', storageKey: 'shared-playback.mp4' }),
			expect.objectContaining({ bucket: 'legacy-protected', storageKey: 'legacy-original.mov' }),
			expect.objectContaining({ bucket: 'legacy-protected', storageKey: 'shared-playback.mp4' }),
		]);
	});
});
