import { describe, expect, it } from 'vitest';
import {
	currentImageRenditions,
	imageRenditionDeletionTargets,
} from '../modules/assets/image-rendition-lifecycle.js';
import {
	projectAssetDeletionTargets,
} from '../modules/admin/project/project-deletion-targets.js';

describe('image rendition lifecycle helpers', () => {
	const rows = [
		{ storageKey: 'current-card.webp', sourceStorageKey: 'current.webp' },
		{ storageKey: 'stale-card.webp', sourceStorageKey: 'old.webp' },
	];

	it('treats only source-matching derivatives as current', () => {
		expect(currentImageRenditions('current.webp', rows)).toEqual([rows[0]]);
		expect(currentImageRenditions(null, rows)).toEqual([]);
	});

	it('queues current rendition objects alongside canonical objects', () => {
		expect(imageRenditionDeletionTargets(
			'public',
			'current.webp',
			rows,
			'asset-delete-rendition',
		)).toEqual([{
			bucket: 'public',
			storageKey: 'current-card.webp',
			reason: 'asset-delete-rendition',
		}]);
	});

	it('preserves GAME/VIDEO bucket and playback deletion behavior', () => {
		expect(projectAssetDeletionTargets([{
			kind: 'VIDEO',
			storageKey: 'original.mp4',
			playbackStorageKey: 'playback.mp4',
			imageRenditions: [],
		}], {
			publicBucket: 'public',
			protectedBucket: 'protected',
			reason: 'project-delete',
		})).toEqual([
			{ bucket: 'protected', storageKey: 'original.mp4', reason: 'project-delete' },
			{ bucket: 'protected', storageKey: 'playback.mp4', reason: 'project-delete-playback' },
		]);
	});
});
