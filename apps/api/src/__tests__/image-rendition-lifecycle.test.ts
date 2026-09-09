import { describe, expect, it } from 'vitest';
import {
	assetImageRenditionReadiness,
	exhibitionImageRenditionReadiness,
	imageRenditionDeletionTargets,
} from '../modules/assets/image-rendition-lifecycle.js';
import { projectAssetDeletionTargets } from '../modules/admin/project/project-deletion-targets.js';
import { deriveImageRenditionStorageKey } from '../shared/responsive-image.js';

describe('image rendition lifecycle helpers', () => {
	const renditions = [
		{ profile: 'CARD_480' as const, width: 480, height: 270 },
		{ profile: 'DISPLAY_960' as const, width: 960, height: 540 },
	];

	it('stores only nullable readiness heights on owners', () => {
		expect(assetImageRenditionReadiness(renditions)).toEqual({
			card480Height: 270,
			display960Height: 540,
		});
		expect(exhibitionImageRenditionReadiness(renditions.slice(0, 1))).toEqual({
			posterCard480Height: 270,
			posterDisplay960Height: null,
		});
	});

	it('rejects duplicate profiles and dimensions that violate profile policy', () => {
		expect(() => assetImageRenditionReadiness([
			...renditions,
			renditions[0]!,
		])).toThrow('Duplicate image rendition profile');
		expect(() => assetImageRenditionReadiness([{
			profile: 'CARD_480',
			width: 479,
			height: 270,
		}])).toThrow('dimensions do not match');
	});

	it('queues every deterministic profile for a removed canonical generation', () => {
		expect(imageRenditionDeletionTargets(
			'public',
			'current.webp',
			'asset-delete-rendition',
		)).toEqual(['CARD_480', 'DISPLAY_960'].map((profile) => ({
			bucket: 'public',
			storageKey: deriveImageRenditionStorageKey(
				'current.webp',
				profile as 'CARD_480' | 'DISPLAY_960',
			),
			reason: 'asset-delete-rendition',
		})));
	});

	it('skips only underivable derivative targets while preserving legacy original deletion', () => {
		const cardSuffixBytes = deriveImageRenditionStorageKey('x', 'CARD_480').length - 1;
		const boundarySource = 'x'.repeat(1_024 - cardSuffixBytes);
		const config = {
			publicBucket: 'public',
			protectedBucket: 'protected',
			reason: 'project-delete',
		};
		expect(imageRenditionDeletionTargets(
			'public',
			boundarySource,
			'asset-delete-rendition',
		)).toEqual([{
			bucket: 'public',
			storageKey: deriveImageRenditionStorageKey(boundarySource, 'CARD_480'),
			reason: 'asset-delete-rendition',
		}]);

		const reservedLegacySource = deriveImageRenditionStorageKey('legacy.webp', 'CARD_480');
		expect(projectAssetDeletionTargets([{
			kind: 'IMAGE',
			storageKey: reservedLegacySource,
			playbackStorageKey: null,
		}], config)).toEqual([{
			bucket: 'public',
			storageKey: reservedLegacySource,
			reason: 'project-delete',
		}]);
	});

	it('adds deterministic derivatives only for responsive asset kinds', () => {
		const config = {
			publicBucket: 'public',
			protectedBucket: 'protected',
			reason: 'project-delete',
		};
		expect(projectAssetDeletionTargets([{
			kind: 'VIDEO',
			storageKey: 'original.mp4',
			playbackStorageKey: 'playback.mp4',
		}], config)).toEqual([
			{ bucket: 'protected', storageKey: 'original.mp4', reason: 'project-delete' },
			{ bucket: 'protected', storageKey: 'playback.mp4', reason: 'project-delete-playback' },
		]);
		expect(projectAssetDeletionTargets([{
			kind: 'IMAGE',
			storageKey: 'original.webp',
			playbackStorageKey: null,
		}], config)).toHaveLength(3);
	});
});
