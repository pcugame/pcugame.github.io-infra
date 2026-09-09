import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createCanonicalAsset } from '../modules/assets/representation-write.js';
import { projectAssetDeletionTargets } from '../modules/admin/project/project-deletion-targets.js';

function transactionHarness() {
	const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
		id: 41,
		...data,
		representations: (data.representations as { create: unknown[] }).create,
	}));
	return { create, tx: { asset: { create } } as never };
}

function representation(role: 'ORIGINAL' | 'PLAYBACK' | 'CARD_480' | 'DISPLAY_960', bucket: string, objectKey: string) {
	return {
		role, bucket, objectKey,
		mimeType: role === 'PLAYBACK' ? 'video/mp4' : role === 'ORIGINAL' ? 'video/quicktime' : 'image/webp',
		sizeBytes: 1_000n, state: 'READY' as const,
		...(role === 'CARD_480' ? { width: 480, height: 320 } : {}),
		...(role === 'DISPLAY_960' ? { width: 960, height: 640 } : {}),
	};
}

describe('canonical asset representation writes', () => {
	it('persists explicit VIDEO original and playback representation rows', async () => {
		const harness = transactionHarness();
		await createCanonicalAsset(harness.tx, {
			projectId: 7, kind: 'VIDEO', originalName: 'video.mov',
			representations: [
				representation('ORIGINAL', 'protected-source', 'protected/assets/41/original/g1.mov'),
				representation('PLAYBACK', 'protected-playback', 'protected/assets/41/playback/g1.mp4'),
			],
		});
		const data = harness.create.mock.calls[0]![0].data as { representations: { create: Array<Record<string, unknown>> } };
		expect(data.representations.create).toEqual([
			expect.objectContaining({ role: 'ORIGINAL', storageBucket: { connect: { bucket: 'protected-source' } }, objectKey: 'protected/assets/41/original/g1.mov', state: 'READY' }),
			expect.objectContaining({ role: 'PLAYBACK', storageBucket: { connect: { bucket: 'protected-playback' } }, objectKey: 'protected/assets/41/playback/g1.mp4', state: 'READY' }),
		]);
	});

	it('persists explicit IMAGE original and responsive roles without deriving object keys', async () => {
		const harness = transactionHarness();
		await createCanonicalAsset(harness.tx, {
			exhibitionId: 3, kind: 'POSTER', originalName: 'poster.webp',
			representations: [
				representation('ORIGINAL', 'public', 'public/images/41/original/g1.webp'),
				representation('CARD_480', 'public', 'public/images/41/card-480/g1.webp'),
				representation('DISPLAY_960', 'public', 'public/images/41/display-960/g1.webp'),
			],
		});
		const data = harness.create.mock.calls[0]![0].data as { representations: { create: Array<Record<string, unknown>> } };
		expect(data.representations.create.map(({ role, objectKey }) => ({ role, objectKey }))).toEqual([
			{ role: 'ORIGINAL', objectKey: 'public/images/41/original/g1.webp' },
			{ role: 'CARD_480', objectKey: 'public/images/41/card-480/g1.webp' },
			{ role: 'DISPLAY_960', objectKey: 'public/images/41/display-960/g1.webp' },
		]);
	});

	it('fails closed for missing ORIGINAL, duplicate roles, or ambiguous ownership', async () => {
		const harness = transactionHarness();
		await expect(createCanonicalAsset(harness.tx, {
			projectId: 7, kind: 'VIDEO', originalName: 'video.mp4',
			representations: [representation('PLAYBACK', 'protected', 'video/playback.mp4')],
		})).rejects.toThrow('ORIGINAL representation is required');
		await expect(createCanonicalAsset(harness.tx, {
			projectId: 7, kind: 'VIDEO', originalName: 'video.mp4',
			representations: [
				representation('ORIGINAL', 'protected', 'video/original.mp4'),
				representation('ORIGINAL', 'protected', 'video/original-duplicate.mp4'),
			],
		})).rejects.toThrow('duplicate or empty role');
		await expect(createCanonicalAsset(harness.tx, {
			kind: 'GAME', originalName: 'game.zip',
			representations: [representation('ORIGINAL', 'protected', 'game.zip')],
		})).rejects.toThrow('exactly one domain owner');
		expect(harness.create).not.toHaveBeenCalled();
	});

	it('contains no Phase-1 compatibility fields or derived rendition-key helper', async () => {
		const source = await readFile(new URL('../modules/assets/representation-write.ts', import.meta.url), 'utf8');
		for (const legacyToken of [
			'originalBucket', 'storageKey', 'playbackStorageKey', 'playbackStatus', 'isPublic',
			'deriveImageRenditionStorageKey', 'SavedImageRendition',
		]) expect(source).not.toContain(legacyToken);
	});

	it('deletes each canonical physical representation once per bucket/key', () => {
		expect(projectAssetDeletionTargets([{ representations: [
			{ role: 'ORIGINAL', bucket: 'protected-v2', objectKey: 'assets/41/original/g1' },
			{ role: 'PLAYBACK', bucket: 'protected-v2', objectKey: 'shared-playback.mp4' },
		] }], {
			publicBucket: 'legacy-public', protectedBucket: 'legacy-protected', reason: 'asset-delete',
		})).toEqual([
			expect.objectContaining({ bucket: 'protected-v2', storageKey: 'assets/41/original/g1' }),
			expect.objectContaining({ bucket: 'protected-v2', storageKey: 'shared-playback.mp4' }),
		]);
	});
});
